import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { AdminRole, Prisma } from '@prisma/client';
import { TreasuryService } from './treasury.service';
import { RailRefusedError, RailUnknownError } from '../naira-rail/naira-rail';
import { dec } from '../common/money';

const OWNER = { id: 'owner-1', role: AdminRole.OWNER };
const SUB = { id: 'sub-1', role: AdminRole.SUB_ADMIN };
const FUNDING = {
  id: 'default', payoutReserveNgn: dec('200000'),
  quidaxFundingBankCode: '058', quidaxFundingBankName: 'GTBank', quidaxFundingAccountNumber: '0123451234', quidaxFundingAccountName: 'QUIDAX TECHNOLOGIES',
};

function build(o: { settings?: Record<string, unknown> | null; railBalance?: string | Error; open?: boolean; transfer?: () => Promise<unknown>; status?: unknown; passwordOk?: boolean; moves?: Array<Record<string, unknown>> } = {}) {
  const moves: Array<Record<string, unknown>> = o.moves ?? [];
  let settings: Record<string, unknown> | null = o.settings === undefined ? { ...FUNDING } : o.settings;
  const rail = {
    name: 'Flutterwave',
    balance: jest.fn(async () => {
      if (o.railBalance instanceof Error) throw o.railBalance;
      return { available: dec(o.railBalance ?? '1000000'), ledger: dec('0') };
    }),
    banks: jest.fn(async () => [{ code: '058', name: 'GTBank' }]),
    resolveAccount: jest.fn(async () => ({ accountName: 'QUIDAX TECHNOLOGIES' })),
    transfer: jest.fn(o.transfer ?? (async () => ({ id: '77', reference: 'x', status: 'PENDING', fee: dec('10.75'), reason: null }))),
    transferStatus: jest.fn(async () => o.status ?? null),
  };
  const prisma = {
    balance: { findMany: jest.fn(async () => []) },
    transaction: { aggregate: jest.fn(async () => ({ _sum: { toAmount: null } })) },
    adminUser: { findUnique: jest.fn(async () => ({ passwordHash: 'h' })) },
    treasurySettings: {
      findUnique: jest.fn(async () => settings),
      upsert: jest.fn(async ({ update }: { update: Record<string, unknown> }) => (settings = { ...(settings ?? {}), ...update })),
    },
    treasuryMove: {
      findMany: jest.fn(async ({ where }: { where?: { status?: { in: string[] }; createdAt?: unknown } } = {}) =>
        where?.status ? moves.filter((m) => where.status!.in.includes(m.status as string)) : moves),
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.status) return o.open ? { id: 'open' } : moves.find((m) => ['SENDING', 'CHECKING'].includes(m.status as string)) ?? null;
        return moves.find((m) => m.reference === where.reference) ?? null;
      }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `m${moves.length + 1}`, ...data, status: 'SENDING' };
        moves.push(row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: { id?: string; reference?: string; status?: { in: string[] } }; data: Record<string, unknown> }) => {
        const row = moves.find((m) => (where.id ? m.id === where.id : m.reference === where.reference) && (!where.status || where.status.in.includes(m.status as string)));
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
  };
  const settlement = { inventory: jest.fn(async () => dec('500000')) };
  const passwords = { verify: jest.fn(async () => o.passwordOk ?? true) };
  const svc = new TreasuryService(prisma as never, rail as never, settlement as never, { raise: jest.fn() } as never, undefined, passwords as never);
  return { svc, rail, prisma, moves, current: () => settings };
}

describe('Treasury settings (owners only, password)', () => {
  it('owners only, and the password must be right', async () => {
    await expect(build().svc.saveSettings(SUB, { payoutReserveNgn: 1, password: 'pw' })).rejects.toThrow(new ForbiddenException('Only an owner can do this'));
    await expect(build({ passwordOk: false }).svc.saveSettings(OWNER, { payoutReserveNgn: 1, password: 'x' })).rejects.toThrow(new BadRequestException('That password is not correct.'));
  });

  it('the payout reserve is a whole naira amount, 0 or more', async () => {
    await expect(build().svc.saveSettings(OWNER, { payoutReserveNgn: -1, password: 'pw' })).rejects.toThrow(new BadRequestException('Enter a whole naira amount, 0 or more.'));
    const { svc, current } = build();
    await svc.saveSettings(OWNER, { payoutReserveNgn: 5000000, password: 'pw' });
    expect(String(current()!.payoutReserveNgn)).toBe('5000000');
  });

  it('the funding account must be at a bank the rail pays; its name comes from the bank', async () => {
    await expect(build().svc.saveSettings(OWNER, { fundingBankCode: '999', fundingAccountNumber: '0123456789', password: 'pw' })).rejects.toThrow(
      new BadRequestException('Choose a supported Nigerian bank'),
    );
    const { svc, current } = build({ settings: { id: 'default', payoutReserveNgn: dec('0') } });
    await svc.saveSettings(OWNER, { fundingBankCode: '058', fundingAccountNumber: '0123451234', password: 'pw' });
    expect(current()).toMatchObject({ quidaxFundingBankCode: '058', quidaxFundingBankName: 'GTBank', quidaxFundingAccountNumber: '0123451234', quidaxFundingAccountName: 'QUIDAX TECHNOLOGIES' });
  });
});

describe('Sending naira to Quidax (owners only, password, no second approval)', () => {
  it('owners only; password; whole naira above zero; a funding account first', async () => {
    await expect(build().svc.sendToQuidax(SUB, { amount: 1000, password: 'pw' })).rejects.toThrow(new ForbiddenException('Only an owner can do this'));
    await expect(build({ passwordOk: false }).svc.sendToQuidax(OWNER, { amount: 1000, password: 'x' })).rejects.toThrow(new BadRequestException('That password is not correct.'));
    await expect(build().svc.sendToQuidax(OWNER, { amount: 0, password: 'pw' })).rejects.toThrow(new BadRequestException('Enter a whole naira amount above zero.'));
    await expect(build({ settings: { id: 'default', payoutReserveNgn: dec('0') } }).svc.sendToQuidax(OWNER, { amount: 1000, password: 'pw' })).rejects.toThrow(
      new BadRequestException('Set the Quidax funding account first.'),
    );
  });

  it('never more than is available to move (rail − reserve − withdrawals being sent)', async () => {
    await expect(build({ railBalance: '1000000' }).svc.sendToQuidax(OWNER, { amount: 900000, password: 'pw' })).rejects.toThrow(
      new BadRequestException('You can move up to ₦800,000 now (the rest is the payout reserve or withdrawals still being sent).'),
    );
  });

  it("refuses when the rail balance can't be read", async () => {
    await expect(build({ railBalance: new Error('timeout') }).svc.sendToQuidax(OWNER, { amount: 1000, password: 'pw' })).rejects.toThrow(
      new ServiceUnavailableException("We couldn't read the Flutterwave balance. Try again shortly."),
    );
  });

  it('one move at a time, also when two arrive together (the database index)', async () => {
    await expect(build({ open: true }).svc.sendToQuidax(OWNER, { amount: 1000, password: 'pw' })).rejects.toThrow(
      new ConflictException('A move is still being sent. Wait for it to arrive or fail.'),
    );
    const racing = build();
    (racing.prisma.treasuryMove.create as jest.Mock).mockImplementationOnce(() => {
      throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'x' });
    });
    await expect(racing.svc.sendToQuidax(OWNER, { amount: 1000, password: 'pw' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('writes the move first, then sends it with our reference to the saved account', async () => {
    const { svc, rail, moves } = build();
    const r = await svc.sendToQuidax(OWNER, { amount: 250000, password: 'pw' });
    expect(moves[0]).toMatchObject({ amount: '250000', toBankCode: '058', toAccountNumber: '0123451234', createdBy: 'owner-1', railRef: '77', status: 'SENDING' });
    expect(String(moves[0].reference)).toMatch(/^trsy_/);
    expect(rail.transfer).toHaveBeenCalledWith(expect.objectContaining({ reference: moves[0].reference, bankCode: '058', accountNumber: '0123451234', narration: 'DavoChain treasury to Quidax' }));
    expect(r).toMatchObject({ status: 'SENDING' });
  });

  it('a clear refusal marks it FAILED with the reason; an unclear answer marks it CHECKING', async () => {
    const refused = build({ transfer: async () => { throw new RailRefusedError('Insufficient balance'); } });
    expect(await refused.svc.sendToQuidax(OWNER, { amount: 1000, password: 'pw' })).toMatchObject({ status: 'FAILED', reason: 'Insufficient balance' });
    expect(refused.moves[0]).toMatchObject({ status: 'FAILED', failureReason: 'Insufficient balance' });
    const unclear = build({ transfer: async () => { throw new RailUnknownError('timeout'); } });
    expect(await unclear.svc.sendToQuidax(OWNER, { amount: 1000, password: 'pw' })).toMatchObject({ status: 'CHECKING' });
  });
});

describe('Finishing a move: the rail is asked by our reference, once', () => {
  const open = () => [{ id: 'm1', reference: 'trsy_a', status: 'SENDING' }];

  it('SUCCESSFUL → ARRIVED; a second check changes nothing', async () => {
    const { svc, moves } = build({ moves: open(), status: { id: '9', reference: 'trsy_a', status: 'SUCCESSFUL', fee: dec('10'), reason: null } });
    await svc.recheck('trsy_a');
    expect(moves[0]).toMatchObject({ status: 'ARRIVED' });
    expect(moves[0].completedAt).toBeInstanceOf(Date);
    await svc.recheck('trsy_a');
    expect(moves[0]).toMatchObject({ status: 'ARRIVED' });
  });

  it('FAILED → FAILED with the reason; still pending or unknown → unchanged', async () => {
    const failed = build({ moves: open(), status: { id: '9', reference: 'trsy_a', status: 'FAILED', fee: null, reason: 'Bank declined' } });
    await failed.svc.recheck('trsy_a');
    expect(failed.moves[0]).toMatchObject({ status: 'FAILED', failureReason: 'Bank declined' });
    const pending = build({ moves: open(), status: { id: '9', reference: 'trsy_a', status: 'PENDING', fee: null, reason: null } });
    await pending.svc.recheck('trsy_a');
    expect(pending.moves[0]).toMatchObject({ status: 'SENDING' });
  });

  it('a reference that is not ours does nothing', async () => {
    const { svc, rail } = build({ moves: open() });
    await svc.recheck('trsy_someone_else');
    expect(rail.transferStatus).not.toHaveBeenCalled();
  });
});

describe('"Check with the bank now" on one move', () => {
  it('asks the rail by the move\'s reference and answers its status; an unknown move is not found', async () => {
    const { svc, moves } = build({ moves: [{ id: 'm1', reference: 'trsy_a', status: 'SENDING' }], status: { id: '9', reference: 'trsy_a', status: 'SUCCESSFUL', fee: null, reason: null } });
    (svc as unknown as { prisma: { treasuryMove: { findUnique: jest.Mock } } }).prisma.treasuryMove.findUnique = jest.fn(async ({ where }: { where: { id: string } }) => moves.find((m) => m.id === where.id) ?? null);
    await expect(svc.checkMove('m1')).resolves.toEqual({ id: 'm1', status: 'ARRIVED', noRecord: false });
    await expect(svc.checkMove('nope')).rejects.toThrow('Move not found');
  });
});

describe('A move the naira rail has no record of (19 Oct: an owner marks it failed)', () => {
  const OLD = new Date(Date.now() - 31 * 60_000);
  const withFind = (b: ReturnType<typeof build>) => {
    (b.prisma.treasuryMove as unknown as { findUnique: jest.Mock }).findUnique = jest.fn(async ({ where }: { where: { id: string } }) => b.moves.find((m) => m.id === where.id) ?? null);
    return b;
  };
  const stuck = (createdAt = OLD) => [{ id: 'm1', reference: 'trsy_a', status: 'SENDING', createdAt }];

  it('"Check with the bank now" says when the rail has no record of the move', async () => {
    const { svc } = withFind(build({ moves: stuck(), status: null }));
    await expect(svc.checkMove('m1')).resolves.toEqual({ id: 'm1', status: 'SENDING', noRecord: true });
  });

  it('an owner, with the password, marks it failed when the rail has no record and it is over 30 minutes old', async () => {
    const { svc, moves, rail } = withFind(build({ moves: stuck(), status: null }));
    const out = await svc.markFailed(OWNER, 'm1', 'pw');
    expect(rail.transferStatus).toHaveBeenCalledWith('trsy_a');
    expect(moves[0]).toMatchObject({ status: 'FAILED' });
    expect(String(moves[0].failureReason)).toMatch(/Flutterwave had no record of it/);
    expect(out).toMatchObject({ before: { status: 'SENDING' }, after: { status: 'FAILED' } });
  });

  it('refuses a sub-admin and a wrong password', async () => {
    await expect(withFind(build({ moves: stuck() })).svc.markFailed(SUB, 'm1', 'pw')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(withFind(build({ moves: stuck(), passwordOk: false })).svc.markFailed(OWNER, 'm1', 'x')).rejects.toThrow('That password is not correct.');
  });

  it('refuses while the rail HAS a record: then it is not ours to decide', async () => {
    const { svc, moves } = withFind(build({ moves: stuck(), status: { id: '9', reference: 'trsy_a', status: 'PENDING', fee: null, reason: null } }));
    await expect(svc.markFailed(OWNER, 'm1', 'pw')).rejects.toBeInstanceOf(ConflictException);
    expect(moves[0]).toMatchObject({ status: 'SENDING' });
  });

  it('refuses a move under 30 minutes old (the rail may simply be slow)', async () => {
    const { svc, rail } = withFind(build({ moves: stuck(new Date(Date.now() - 5 * 60_000)), status: null }));
    await expect(svc.markFailed(OWNER, 'm1', 'pw')).rejects.toThrow(/30 minutes/);
    expect(rail.transferStatus).not.toHaveBeenCalled();
  });

  it('refuses when the rail cannot be reached: "no answer" is not "no record"', async () => {
    const b = withFind(build({ moves: stuck() }));
    b.rail.transferStatus.mockRejectedValueOnce(new Error('timeout'));
    await expect(b.svc.markFailed(OWNER, 'm1', 'pw')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(b.moves[0]).toMatchObject({ status: 'SENDING' });
  });

  it('refuses a move that already finished, and an unknown move', async () => {
    const done = withFind(build({ moves: [{ id: 'm1', reference: 'trsy_a', status: 'ARRIVED', createdAt: OLD }] }));
    await expect(done.svc.markFailed(OWNER, 'm1', 'pw')).rejects.toBeInstanceOf(ConflictException);
    await expect(done.svc.markFailed(OWNER, 'nope', 'pw')).rejects.toThrow('Move not found');
  });

  it('the screen offers the button only on open moves over 30 minutes old', async () => {
    const { svc } = build({ moves: [
      { id: 'a', reference: 'r1', status: 'SENDING', amount: '1000', toBankName: 'B', toAccountNumber: '0123456789', createdAt: OLD },
      { id: 'b', reference: 'r2', status: 'SENDING', amount: '1000', toBankName: 'B', toAccountNumber: '0123456789', createdAt: new Date() },
      { id: 'c', reference: 'r3', status: 'ARRIVED', amount: '1000', toBankName: 'B', toAccountNumber: '0123456789', createdAt: OLD },
    ] });
    const s = await svc.snapshot();
    expect(s.moves.map((m) => [m.id, m.canMarkFailed])).toEqual([['a', true], ['b', false], ['c', false]]);
  });
});
