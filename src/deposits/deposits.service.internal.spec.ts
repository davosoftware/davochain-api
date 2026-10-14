import { DepositsService } from './deposits.service';

/**
 * Quidax fires deposit.successful with type "internal" when coins arrive from
 * another Quidax account. Every buy ends with exactly that (main -> the user's
 * sub-account), so treating it as a customer deposit made a phantom PENDING
 * "deposit" and a "BTC added" notification after every buy, and was one status
 * value away from crediting the coin twice (PROJECT_REVIEW H12).
 */
function build() {
  const prisma = {
    transaction: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn() },
    asset: { findUnique: jest.fn().mockResolvedValue({ code: 'btc' }) },
  };
  const provisioning = { findUserByQuidax: jest.fn().mockResolvedValue('user-1') };
  const notifications = { notify: jest.fn() };
  const ledger = { credit: jest.fn() };
  const rates = { price: jest.fn().mockResolvedValue({ priceUsd: '60000', ngnPerUsd: '1500' }) };
  const svc = new DepositsService(prisma as never, ledger as never, provisioning as never, notifications as never, rates as never, {} as never);
  return { svc, prisma, notifications, ledger, provisioning };
}

/** The documented DEPOSIT.SUCCESSFUL(INTERNAL) shape. */
const internal = (status = 'checked') => ({
  id: 'dep-internal-1',
  type: 'internal',
  currency: 'btc',
  amount: '0.01',
  fee: '0.0',
  txid: null,
  status,
  reason: null,
  created_at: '2026-10-14T10:00:00Z',
  done_at: '2026-10-14T10:00:00Z',
  user: { id: 'qx-sub-1', sn: 'QDX1' },
});

describe('DepositsService: internal transfers are never customer deposits', () => {
  it.each(['checked', 'accepted'])('a webhook with type "internal" (status %s) records nothing and notifies nobody', async (status) => {
    const { svc, prisma, notifications, ledger } = build();
    await svc.applyWebhook('deposit.successful', internal(status) as never);
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(prisma.transaction.update).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(ledger.credit).not.toHaveBeenCalled();
  });

  it('"INTERNAL" in any case is skipped too', async () => {
    const { svc, prisma } = build();
    await svc.applyWebhook('deposit.successful', { ...internal('accepted'), type: 'INTERNAL' } as never);
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('the gap sweep skips internal transfers and does not count them as recovered', async () => {
    const { svc, prisma } = build();
    expect(await svc.sweepGaps([internal('accepted')] as never)).toBe(0);
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('a real on-chain deposit (type coin_address) is still recorded', async () => {
    const { svc, prisma } = build();
    prisma.transaction.create.mockResolvedValue({ id: 'tx-1', status: 'PENDING' });
    await svc.applyWebhook('deposit.transaction.confirmation', { ...internal('submitted'), type: 'coin_address', txid: '0xabc' } as never);
    expect(prisma.transaction.create).toHaveBeenCalled();
  });
});
