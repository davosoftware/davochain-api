import { Prisma } from '@prisma/client';
import { DepositsService } from './deposits.service';

describe('DepositsService.history', () => {
  it('says which rail a deposit came by, and the sending bank for a naira transfer', async () => {
    const at = new Date('2026-10-07T14:15:00.000Z');
    const prisma = {
      transaction: {
        findMany: jest.fn(async () => [
          {
            id: 't1', toAsset: 'ngn', toAmount: new Prisma.Decimal('1500.5'), status: 'COMPLETED', failureReason: null,
            provider: 'FLUTTERWAVE', counterpartyBank: 'Access Bank', counterpartyName: 'JOHN DOE', createdAt: at, completedAt: at,
          },
        ]),
      },
    };
    const svc = new DepositsService(prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    await expect(svc.history('u1')).resolves.toEqual([
      {
        id: 't1', asset: 'ngn', amount: '1500.5', status: 'COMPLETED', reason: null,
        provider: 'FLUTTERWAVE', counterpartyBank: 'Access Bank', from: null, createdAt: at, completedAt: at,
      },
    ]);
  });

  it('a send from another DavoChain customer says who it came from', async () => {
    const at = new Date('2026-10-28T14:15:00.000Z');
    const prisma = {
      transaction: {
        findMany: jest.fn(async () => [
          { id: 't2', toAsset: 'usdt', toAmount: new Prisma.Decimal('5'), status: 'COMPLETED', failureReason: null, provider: 'QUIDAX', counterpartyBank: null, peerUserId: 'alice', createdAt: at, completedAt: at },
        ]),
      },
      user: { findMany: jest.fn(async () => [{ id: 'alice', firstName: 'Alice', lastName: 'Okafor', payUsername: 'alice_ok' }]) },
    };
    const svc = new DepositsService(prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    const [row] = await svc.history('u1');
    expect(row.from).toEqual({ username: 'alice_ok', displayName: 'Alice O.' });
  });
});
