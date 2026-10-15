import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AdminRole, LedgerAccount, LedgerDirection, TxStatus, TxType } from '@prisma/client';
import { BalanceCorrectionsService } from './balance-corrections.service';
import { dec } from '../common/money';

const OWNER = { id: 'owner-1', role: AdminRole.OWNER };
const SUB = { id: 'sub-1', role: AdminRole.SUB_ADMIN };

function build(o: { available?: string; user?: boolean; listed?: boolean } = {}) {
  const posted: Array<{ legs: Array<Record<string, unknown>>; txId: string }> = [];
  const created: Array<Record<string, unknown>> = [];
  let available = dec(o.available ?? '1');
  const t = {
    transaction: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => (created.push(data), { id: 'adj-tx', ...data })) },
  };
  const prisma = {
    user: { findUnique: jest.fn(async () => (o.user === false ? null : { id: 'u1' })) },
    asset: { findFirst: jest.fn(async () => (o.listed === false ? null : { code: 'btc', displayScale: 8 })) },
    transaction: { findMany: jest.fn(async () => []) },
    serializable: jest.fn((fn: (x: unknown) => unknown) => fn(t)),
  };
  const ledger = {
    getBalance: jest.fn(async () => ({ available, locked: dec('0') })),
    post: jest.fn(async (_t: unknown, legs: Array<Record<string, unknown>>, txId: string) => {
      posted.push({ legs, txId });
      const user = legs.find((l) => l.account === LedgerAccount.USER)!;
      const delta = dec(user.amount as string);
      available = user.direction === LedgerDirection.CREDIT ? available.plus(delta) : available.minus(delta);
    }),
  };
  return { svc: new BalanceCorrectionsService(prisma as never, ledger as never), posted, created };
}

const input = (over: Record<string, unknown> = {}) => ({ userId: 'u1', asset: 'btc', direction: 'CREDIT' as const, amount: '0.002', reason: 'Quidax shows 0.002 more after a lost deposit webhook', ...over });

describe('Balance corrections (reconciliation)', () => {
  it('only an owner can correct a balance', async () => {
    await expect(build().svc.correct(SUB, input())).rejects.toThrow(new ForbiddenException('Only an owner can correct a balance'));
  });

  it.each([
    [{ reason: 'too short' }, 'Write a reason (at least 10 characters)'],
    [{ amount: '0' }, 'Enter an amount greater than zero'],
    [{ amount: 'abc' }, 'Enter an amount greater than zero'],
    [{ amount: '-1' }, 'Enter an amount greater than zero'],
  ])('refuses %o', async (over, message) => {
    await expect(build().svc.correct(OWNER, input(over))).rejects.toThrow(new BadRequestException(message));
  });

  it('refuses a coin that is not a listed crypto coin, and an unknown customer', async () => {
    await expect(build({ listed: false }).svc.correct(OWNER, input())).rejects.toThrow(new BadRequestException('Choose a listed coin'));
    await expect(build({ user: false }).svc.correct(OWNER, input())).rejects.toThrow(new NotFoundException('User not found'));
  });

  it('a credit posts ADJUSTMENT → customer, records who and why, and returns before and after', async () => {
    const { svc, posted, created } = build({ available: '1' });
    const r = await svc.correct(OWNER, input());
    expect(created[0]).toMatchObject({
      userId: 'u1', type: TxType.ADJUSTMENT, status: TxStatus.COMPLETED, toAsset: 'btc', toAmount: '0.002',
      adjustedBy: 'owner-1', adjustmentReason: 'Quidax shows 0.002 more after a lost deposit webhook',
    });
    expect(String(created[0].reference)).toMatch(/^adj_/);
    expect(posted[0].legs).toEqual([
      expect.objectContaining({ account: LedgerAccount.ADJUSTMENT, direction: LedgerDirection.DEBIT, amount: '0.002', assetCode: 'btc' }),
      expect.objectContaining({ account: LedgerAccount.USER, userId: 'u1', direction: LedgerDirection.CREDIT, amount: '0.002' }),
    ]);
    expect(r).toEqual({ transactionId: 'adj-tx', before: '1', after: '1.002' });
  });

  it('a debit posts customer → ADJUSTMENT, and cannot take more than is available', async () => {
    const { svc, posted, created } = build({ available: '0.01' });
    await svc.correct(OWNER, input({ direction: 'DEBIT', amount: '0.004' }));
    expect(created[0]).toMatchObject({ fromAsset: 'btc', fromAmount: '0.004' });
    expect(posted[0].legs).toEqual([
      expect.objectContaining({ account: LedgerAccount.USER, direction: LedgerDirection.DEBIT }),
      expect.objectContaining({ account: LedgerAccount.ADJUSTMENT, direction: LedgerDirection.CREDIT }),
    ]);
    await expect(build({ available: '0.001' }).svc.correct(OWNER, input({ direction: 'DEBIT', amount: '0.004' }))).rejects.toThrow(
      new BadRequestException('The customer only has 0.00100000 BTC available'),
    );
  });
});
