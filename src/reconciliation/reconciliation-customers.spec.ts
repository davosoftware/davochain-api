import { BadRequestException } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service';

/**
 * The reconciliation screen opens a coin and lists the customers whose record
 * doesn't match what their Quidax sub-account holds, with the likely reason.
 */
type Holder = { userId: string; available: string; locked: string };

function build(o: {
  holders: Holder[];
  fees?: Array<{ userId: string; amount: string }>;
  held: Record<string, string | Error>;
  open?: Array<{ id: string; userId: string; type: string; status: string; createdAt: Date }>;
}) {
  const prisma = {
    asset: { findFirst: jest.fn(async ({ where }: { where: { code: string } }) => (where.code === 'btc' ? { code: 'btc' } : null)) },
    balance: { findMany: jest.fn(async () => o.holders.map((h) => ({ ...h, assetCode: 'btc' }))) },
    feeReceivable: { findMany: jest.fn(async () => (o.fees ?? []).map((f) => ({ ...f, assetCode: 'btc' }))) },
    user: {
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, firstName: 'Ada', lastName: id, email: `${id}@x.com` }))),
    },
    transaction: { findMany: jest.fn(async () => o.open ?? []) },
  };
  const quidax = {
    fetchWallets: jest.fn(async (sub: string) => {
      const v = o.held[sub.replace('sub-', '')];
      if (v instanceof Error) throw v;
      return [{ currency: 'btc', balance: v ?? '0' }];
    }),
  };
  const settlement = { quidaxIdFor: jest.fn(async (id: string) => `sub-${id}`) };
  return new ReconciliationService(prisma as never, quidax as never, {} as never, settlement as never, {} as never, {} as never);
}

describe('Reconciliation: which customers don\'t match, and why', () => {
  it('leaves out customers who match; counts available + locked + uncollected fees as our record', async () => {
    const r = await build({
      holders: [{ userId: 'u1', available: '0.01', locked: '0' }, { userId: 'u2', available: '0.005', locked: '0.001' }],
      fees: [{ userId: 'u2', amount: '0.0005' }],
      held: { u1: '0.01', u2: '0.006' },
    }).customersFor('btc');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ userId: 'u2', recorded: '0.0065', held: '0.006', difference: '0.0005', reason: 'UNEXPLAINED', email: 'u2@x.com' });
  });

  it('a send being checked, or a trade in progress, is named as the likely reason', async () => {
    const at = new Date('2026-10-15T10:00:00Z');
    const r = await build({
      holders: [{ userId: 'u1', available: '0.01', locked: '0.002' }, { userId: 'u2', available: '0.01', locked: '0.001' }],
      held: { u1: '0.01', u2: '0.01' },
      open: [
        { id: 't1', userId: 'u1', type: 'WITHDRAWAL', status: 'RECONCILING', createdAt: at },
        { id: 't2', userId: 'u2', type: 'SELL', status: 'PROCESSING', createdAt: at },
      ],
    }).customersFor('btc');
    const byUser = Object.fromEntries(r.rows.map((x) => [x.userId, x]));
    expect(byUser.u1).toMatchObject({ reason: 'BEING_CHECKED', open: [{ id: 't1', status: 'RECONCILING' }] });
    expect(byUser.u2).toMatchObject({ reason: 'IN_PROGRESS', open: [{ id: 't2' }] });
  });

  it('a sub-account that could not be read is listed as unreadable, never as missing money', async () => {
    const r = await build({ holders: [{ userId: 'u1', available: '0.01', locked: '0' }], held: { u1: new Error('timeout') } }).customersFor('btc');
    expect(r.rows[0]).toMatchObject({ userId: 'u1', held: null, difference: null, unreadable: true, reason: 'UNREADABLE' });
    expect(r.partial).toBe(true);
  });

  it('a coin that is not listed is refused', async () => {
    await expect(build({ holders: [], held: {} }).customersFor('doge')).rejects.toThrow(new BadRequestException('Choose a listed coin'));
  });
});
