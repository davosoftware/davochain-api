import { BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SavedDestinationsService } from './saved-destinations.service';
import { recordFailedLogin } from '../auth/failed-logins';

jest.mock('../auth/failed-logins', () => ({ recordFailedLogin: jest.fn(async () => ({ failedLogins: 1, lockedUntil: null, justLocked: false })) }));

const NOW = new Date('2026-10-15T10:00:00Z');
const BTC = { isListed: true, withdrawsEnabled: true, requiresTag: false, addressRegex: '^bc1[a-z0-9]{8,}$', label: 'Bitcoin' };

function build(o: { rows?: Array<Record<string, unknown>>; max?: number; hours?: number; passwordOk?: boolean; lockedUntil?: Date | null } = {}) {
  const rows: Array<Record<string, unknown>> = o.rows ?? [];
  const notify = jest.fn(async () => undefined);
  const table = (kind: string) => ({
    count: jest.fn(async ({ where }: { where: { userId: string } }) => rows.filter((r) => r.kind === kind && r.userId === where.userId && !r.removedAt).length),
    findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows.find((r) => r.kind === kind && Object.entries(where).every(([k, v]) => (v === null ? !r[k] : r[k] === v))) ?? null),
    findMany: jest.fn(async ({ where }: { where: { userId: string } }) => rows.filter((r) => r.kind === kind && r.userId === where.userId && !r.removedAt)),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { kind, id: `${kind}-${rows.length + 1}`, createdAt: NOW, removedAt: null, nickname: null, destinationTag: null, ...data };
      rows.push(row);
      return row;
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(rows.find((r) => r.id === where.id)!, data)),
  });
  const t = {
    platformLimit: { findUnique: jest.fn(async () => ({ maxSavedBankAccounts: o.max ?? 5, maxSavedCryptoAddresses: o.max ?? 10 })) },
    levelCooloff: { findUnique: jest.fn(async () => ({ afterNewPayeeHours: o.hours ?? 0 })) },
    savedBankAccount: table('bank'),
    savedCryptoAddress: table('crypto'),
  };
  const prisma = {
    ...t,
    user: { findUnique: jest.fn(async () => ({ id: 'u1', passwordHash: 'h', kycTier: 'TIER_1', lockedUntil: o.lockedUntil ?? null })) },
    assetNetwork: { findUnique: jest.fn(async () => BTC), findMany: jest.fn(async () => [{ assetCode: 'btc', networkId: 'btc', label: 'Bitcoin' }]) },
    serializable: jest.fn((fn: (x: unknown) => unknown) => fn(t)),
  };
  const passwords = { verify: jest.fn(async () => o.passwordOk ?? true) };
  const withdrawals = {
    lookupNgnBankAccount: jest.fn(async ({ bankCode }: { bankCode: string }) => {
      if (bankCode !== '058') throw new BadRequestException('Choose a supported Nigerian bank');
      return { bankName: 'GTBank', accountName: 'ADA OKAFOR' };
    }),
  };
  const svc = new SavedDestinationsService(prisma as never, passwords as never, withdrawals as never, { notify } as never);
  return { svc, rows, notify, prisma, withdrawals };
}

const BANK = { bankCode: '058', accountNumber: '0123451234', password: 'pw' };
const ADDR = { asset: 'btc', network: 'btc', address: 'bc1qxyz12345678', password: 'pw' };

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'setTimeout'] });
  (recordFailedLogin as jest.Mock).mockClear();
});
afterEach(() => jest.useRealTimers());

describe('Adding a bank account', () => {
  it('a wrong password is refused, counts towards the sign-in lockout, and saves nothing', async () => {
    const { svc, rows } = build({ passwordOk: false });
    await expect(svc.addBank('u1', BANK)).rejects.toThrow(new UnauthorizedException('Incorrect password'));
    expect(recordFailedLogin).toHaveBeenCalledWith(expect.anything(), 'users', 'u1');
    expect(rows).toHaveLength(0);
  });

  it('a locked account is refused with the sign-in lockout message', async () => {
    const { svc } = build({ lockedUntil: new Date('2026-10-15T11:00:00Z') });
    await expect(svc.addBank('u1', BANK)).rejects.toThrow(new ForbiddenException('Too many failed attempts. Try again after 2026-10-15T11:00:00.000Z'));
  });

  it('a bank not in the live list is refused', async () => {
    const { svc } = build();
    await expect(svc.addBank('u1', { ...BANK, bankCode: '999' })).rejects.toThrow(new BadRequestException('Choose a supported Nigerian bank'));
  });

  it('saves the name the bank returned, usable after the level cool-off, and emails the customer', async () => {
    const { svc, rows, notify } = build({ hours: 24 });
    const view = await svc.addBank('u1', { ...BANK, nickname: 'Salary' });
    expect(rows[0]).toMatchObject({ userId: 'u1', bankCode: '058', bankName: 'GTBank', accountNumber: '0123451234', accountName: 'ADA OKAFOR', nickname: 'Salary' });
    expect(view).toMatchObject({ accountNumberMasked: '******1234', accountName: 'ADA OKAFOR', usableFrom: '2026-10-16T10:00:00.000Z', usableNow: false });
    expect(view).not.toHaveProperty('accountNumber');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', type: 'security.destination_added', email: expect.objectContaining({ key: 'destination.added' }) }));
  });

  it('at the cap: refused with the number in plain words', async () => {
    const { svc } = build({ max: 1, rows: [{ kind: 'bank', id: 'b0', userId: 'u1', bankCode: '058', accountNumber: '9999999999', removedAt: null }] });
    await expect(svc.addBank('u1', BANK)).rejects.toThrow(new BadRequestException('You can save up to 1 bank account. Remove one to add another.'));
  });

  it('the same account twice is refused; the database index says the same thing in a race', async () => {
    const { svc, prisma } = build({ rows: [{ kind: 'bank', id: 'b0', userId: 'u1', bankCode: '058', accountNumber: '0123451234', removedAt: null }] });
    await expect(svc.addBank('u1', BANK)).rejects.toThrow(new BadRequestException('This account is already saved.'));
    const { svc: racing } = build();
    (prisma.serializable as jest.Mock).mockImplementation(() => {
      throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'x' });
    });
    Object.assign(racing, { prisma });
    await expect(racing.addBank('u1', BANK)).rejects.toThrow(new BadRequestException('This account is already saved.'));
  });

  it('a removed account can be saved again, with a fresh wait', async () => {
    const { svc, rows } = build({ hours: 2, rows: [{ kind: 'bank', id: 'b0', userId: 'u1', bankCode: '058', accountNumber: '0123451234', removedAt: NOW }] });
    const view = await svc.addBank('u1', BANK);
    expect(rows).toHaveLength(2);
    expect(view.usableFrom).toBe('2026-10-15T12:00:00.000Z');
  });
});

describe('Adding a crypto address', () => {
  it('checks the address with the network rules', async () => {
    const { svc } = build();
    await expect(svc.addCrypto('u1', { ...ADDR, address: '0xnope' })).rejects.toThrow(new BadRequestException('That does not look like a valid Bitcoin address'));
  });

  it('duplicates and the cap say "address"', async () => {
    const dup = build({ rows: [{ kind: 'crypto', id: 'c0', userId: 'u1', assetCode: 'btc', networkId: 'btc', address: 'bc1qxyz12345678', destinationTag: null, removedAt: null }] });
    await expect(dup.svc.addCrypto('u1', ADDR)).rejects.toThrow(new BadRequestException('This address is already saved.'));
    const full = build({ max: 1, rows: [{ kind: 'crypto', id: 'c0', userId: 'u1', assetCode: 'eth', networkId: 'eth', address: '0x1', removedAt: null }] });
    await expect(full.svc.addCrypto('u1', ADDR)).rejects.toThrow(new BadRequestException('You can save up to 1 crypto address. Remove one to add another.'));
  });

  it('saves and reports the network label', async () => {
    const { svc } = build();
    await expect(svc.addCrypto('u1', ADDR)).resolves.toMatchObject({ assetCode: 'btc', networkId: 'btc', networkLabel: 'Bitcoin', address: 'bc1qxyz12345678', usableNow: true });
  });
});

describe('Listing and removing', () => {
  it('lists live rows only, masked, with the cap', async () => {
    const { svc } = build({
      rows: [
        { kind: 'bank', id: 'b1', userId: 'u1', bankCode: '058', bankName: 'GTBank', accountNumber: '0123451234', accountName: 'A', usableFrom: NOW, createdAt: NOW, removedAt: null },
        { kind: 'bank', id: 'b2', userId: 'u1', bankCode: '058', bankName: 'GTBank', accountNumber: '0000000000', accountName: 'A', usableFrom: NOW, createdAt: NOW, removedAt: NOW },
      ],
    });
    const list = await svc.listBanks('u1');
    expect(list.max).toBe(5);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: 'b1', accountNumberMasked: '******1234', usableNow: true });
  });

  it('someone else\'s or an already removed destination is not found', async () => {
    const { svc } = build({ rows: [{ kind: 'bank', id: 'b1', userId: 'u2', removedAt: null }, { kind: 'bank', id: 'b2', userId: 'u1', removedAt: NOW }] });
    await expect(svc.remove('bank', 'u1', 'b1', 'user')).rejects.toThrow(new NotFoundException('Saved account not found'));
    await expect(svc.remove('bank', 'u1', 'b2', 'user')).rejects.toThrow(new NotFoundException('Saved account not found'));
    await expect(svc.remove('crypto', 'u1', 'x', 'user')).rejects.toThrow(new NotFoundException('Saved address not found'));
  });

  it('removing your own sets removedAt and who removed it', async () => {
    const { svc, rows } = build({ rows: [{ kind: 'bank', id: 'b1', userId: 'u1', bankCode: '058', bankName: 'GTBank', accountNumber: '0123451234', accountName: 'A', usableFrom: NOW, createdAt: NOW, removedAt: null }] });
    await svc.remove('bank', 'u1', 'b1', 'user');
    expect(rows[0]).toMatchObject({ removedBy: 'user' });
    expect(rows[0].removedAt).toBeInstanceOf(Date);
  });
});
