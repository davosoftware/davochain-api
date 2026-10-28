import { LedgerAccount, TxStatus, TxType } from '@prisma/client';
import { SettlementService } from './settlement.service';

/**
 * The receiving half of a send between two DavoChain customers (28 Oct 2026).
 * Quidax's own "internal" deposit for the receiver is ignored on purpose (H12),
 * so this is the one place the receiver is credited, and it must happen once.
 */
function build(status: TxStatus = TxStatus.PENDING) {
  const sent = {
    id: 'tx-1', userId: 'alice', peerUserId: 'bob', type: TxType.WITHDRAWAL, status,
    reference: 'dvc_peer_1', fromAsset: 'btc', fromAmount: '0.01', toAsset: 'btc', toAmount: '0.01', usdValue: '600',
  };
  const created: any[] = [];
  const t = {
    transaction: {
      updateMany: jest.fn(async ({ where }: any) => {
        if (!where.status.in.includes(sent.status)) return { count: 0 };
        sent.status = TxStatus.COMPLETED;
        return { count: 1 };
      }),
      create: jest.fn(async ({ data }: any) => (created.push(data), { id: 'tx-in', ...data })),
    },
    settlementLeg: { updateMany: jest.fn() },
  };
  const prisma = {
    transaction: { findUniqueOrThrow: jest.fn(async () => ({ ...sent })), findFirst: jest.fn(async () => ({ ...sent })) },
    settlementLeg: { findUnique: jest.fn(async () => null) },
    user: { findUnique: jest.fn(async () => ({ firstName: 'Alice', lastName: 'Okafor' })) },
    serializable: jest.fn((fn: (tx: unknown) => unknown) => fn(t)),
  };
  const ledger = { settleLocked: jest.fn(), credit: jest.fn(), unlock: jest.fn() };
  const notifications = { notify: jest.fn() };
  const service = new SettlementService(prisma as never, {} as never, ledger as never, notifications as never, {} as never, {} as never);
  return { service, ledger, notifications, created, sent };
}

describe('completePeerSend: the receiver is credited exactly once', () => {
  it("takes the coins from the sender and gives them to the receiver, through IN_FLIGHT", async () => {
    const { service, ledger, created } = build();
    await expect(service.completePeerSend('tx-1', 'IW-1')).resolves.toBe(true);
    expect(ledger.settleLocked).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: 'alice', assetCode: 'btc', counterparty: LedgerAccount.IN_FLIGHT, transactionId: 'tx-1' }));
    expect(ledger.settleLocked.mock.calls[0][1].amount.toString()).toBe('0.01');
    expect(created[0]).toMatchObject({ userId: 'bob', type: TxType.DEPOSIT, status: TxStatus.COMPLETED, peerUserId: 'alice', reference: 'dvc_peer_1_in', toAmount: '0.01', counterpartyName: 'Alice O.' });
    expect(ledger.credit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: 'bob', assetCode: 'btc', counterparty: LedgerAccount.IN_FLIGHT, transactionId: 'tx-in' }));
  });

  it('tells both people', async () => {
    const { service, notifications } = build();
    await service.completePeerSend('tx-1', 'IW-1');
    const who = notifications.notify.mock.calls.map((c) => [c[0].userId, c[0].email?.key]);
    expect(who).toEqual([['alice', 'withdrawal.sent'], ['bob', 'deposit.credited']]);
  });

  it('a second call (webhook, reconciler) does nothing', async () => {
    const { service, ledger } = build(TxStatus.COMPLETED);
    await expect(service.completePeerSend('tx-1', 'IW-1')).resolves.toBe(false);
    expect(ledger.credit).not.toHaveBeenCalled();
  });

  it("Quidax's withdrawal webhook for a peer send completes it this way, not as a chain withdrawal", async () => {
    const { service, ledger } = build(TxStatus.RECONCILING);
    await service.applyWithdrawalWebhook('withdraw.successful', { id: 'IW-1', reference: 'dvc_peer_1', status: 'done' } as never);
    expect(ledger.credit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: 'bob' }));
  });
});
