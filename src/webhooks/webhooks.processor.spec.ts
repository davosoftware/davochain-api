import { WebhooksProcessor } from './webhooks.processor';
import { JOBS } from '../common/queues';

/** OPEN_ISSUES A1: every Quidax money or address message goes through what Quidax itself says. */
function setup(payload: { event: string; data: Record<string, unknown> }, confirmed: unknown = null) {
  const prisma = {
    webhookEvent: {
      findUnique: jest.fn(async () => ({ id: 'e1', processedAt: null, payload })),
      update: jest.fn(async () => ({})),
    },
    depositAddress: { findFirst: jest.fn(async () => ({ id: 'addr-row-1' })) },
  };
  const addresses = { resolve: jest.fn(async () => null), applyGenerated: jest.fn(async () => null), findByAddress: jest.fn(async () => null) };
  const deposits = { applyWebhook: jest.fn(async () => undefined) };
  const settlement = { applyWithdrawalWebhook: jest.fn(async () => undefined), applySwapWebhook: jest.fn(async () => undefined) };
  const confirm = {
    deposit: jest.fn(async () => confirmed),
    withdrawal: jest.fn(async () => confirmed),
    swap: jest.fn(async () => confirmed),
  };
  const p = new WebhooksProcessor(prisma as never, addresses as never, { findUserByQuidax: jest.fn(async () => 'u1') } as never, deposits as never, settlement as never, confirm as never);
  const run = () => p.process({ name: JOBS.PROCESS_WEBHOOK, data: { webhookEventId: 'e1' } } as never);
  return { run, prisma, addresses, deposits, settlement, confirm };
}

describe('WebhooksProcessor: Quidax messages are prompts, Quidax is the evidence', () => {
  it('a deposit is credited from Quidax\'s own record', async () => {
    const real = { id: 'd1', amount: '5' };
    const s = setup({ event: 'deposit.successful', data: { id: 'd1', amount: '1000000' } }, real);
    await s.run();
    expect(s.deposits.applyWebhook).toHaveBeenCalledWith('deposit.successful', real);
  });

  it('a deposit Quidax does not know is dropped, and the message marked handled', async () => {
    const s = setup({ event: 'deposit.successful', data: { id: 'fake' } }, null);
    await s.run();
    expect(s.deposits.applyWebhook).not.toHaveBeenCalled();
    expect(s.prisma.webhookEvent.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ processedAt: expect.any(Date) }) }));
  });

  it('a withdrawal is finished with the event Quidax\'s record amounts to', async () => {
    const real = { event: 'withdraw.successful', data: { reference: 'r', status: 'Done' } };
    const s = setup({ event: 'withdraw.rejected', data: { reference: 'r' } }, real);
    await s.run();
    expect(s.settlement.applyWithdrawalWebhook).toHaveBeenCalledWith('withdraw.successful', real.data);
  });

  it('a swap is finished with the event Quidax\'s record amounts to', async () => {
    const real = { event: 'swap_transaction.failed', data: { id: 's1', status: 'failed' } };
    const s = setup({ event: 'swap_transaction.complete', data: { id: 's1' } }, real);
    await s.run();
    expect(s.settlement.applySwapWebhook).toHaveBeenCalledWith('swap_transaction.failed', real.data);
  });

  it('a withdrawal or swap Quidax does not confirm changes nothing', async () => {
    const w = setup({ event: 'withdraw.rejected', data: { reference: 'r' } }, null);
    await w.run();
    expect(w.settlement.applyWithdrawalWebhook).not.toHaveBeenCalled();
    const sw = setup({ event: 'swap_transaction.failed', data: { id: 's1' } }, null);
    await sw.run();
    expect(sw.settlement.applySwapWebhook).not.toHaveBeenCalled();
  });

  it('an address message never sets the address from its own contents: Quidax is asked for the customer\'s addresses', async () => {
    const s = setup({ event: 'wallet.address.generated', data: { id: 'qa1', address: 'ATTACKER-ADDRESS', currency: 'usdt' } });
    await s.run();
    expect(s.addresses.resolve).toHaveBeenCalledWith('addr-row-1');
    expect(s.addresses.applyGenerated).not.toHaveBeenCalled();
  });
});
