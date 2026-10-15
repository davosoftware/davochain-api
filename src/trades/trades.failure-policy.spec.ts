import { BadRequestException } from '@nestjs/common';
import { TxStatus } from '@prisma/client';
import { SettlementService } from './settlement.service';
import { QuidaxError, QuidaxRateLimitError, QuidaxUnknownError } from '../quidax/quidax.errors';

/**
 * C4 (PROJECT_REVIEW): only a definite refusal from Quidax may refund a trade.
 *
 * Anything else (our own database failing after Quidax moved the coin, a
 * programming error, an unclear answer) leaves the funds locked and the trade
 * RECONCILING. And once any step of the trade has gone out to Quidax, a later
 * failure never refunds the whole trade (the partial-buy case from H3).
 */
async function handle(err: unknown, legsSent = 0) {
  const { TradesService } = await import('./trades.service');
  const settlement = Object.create(SettlementService.prototype) as SettlementService;
  const reverse = jest.fn(async () => undefined);
  const markReconciling = jest.fn(async () => undefined);
  Object.assign(settlement, { reverse, markReconciling });
  const svc = Object.create(TradesService.prototype) as Record<string, unknown>;
  Object.assign(svc, {
    settlement,
    prisma: { settlementLeg: { count: jest.fn(async () => legsSent) } },
  });
  const quote = { fromAsset: 'ngn', toAsset: 'btc', fromAmount: '1000', toAmount: '0.0001' };
  const run = (svc.handleFailure as (...a: unknown[]) => Promise<{ status: TxStatus }>).bind(svc);
  const outcome = await run(err, 'tx1', 'u1', quote).catch((e: unknown) => e);
  return { outcome, reverse, markReconciling };
}

describe('C4: when a trade may be refunded', () => {
  it('a definite business refusal before anything went out refunds', async () => {
    const { outcome, reverse } = await handle(new QuidaxError('Insufficient balance', null, 422));
    expect(reverse).toHaveBeenCalled();
    expect(outcome).toBeInstanceOf(BadRequestException);
  });

  it('a rate-limit refusal (nothing happened) refunds', async () => {
    const { reverse } = await handle(new QuidaxRateLimitError(429, 1000));
    expect(reverse).toHaveBeenCalled();
  });

  it('an unknown outcome does not refund', async () => {
    const { outcome, reverse } = await handle(new QuidaxUnknownError('timeout', 'POST', '/x'));
    expect(reverse).not.toHaveBeenCalled();
    expect((outcome as { status: TxStatus }).status).toBe(TxStatus.RECONCILING);
  });

  it('our own database failing (after Quidax moved the coin) does not refund', async () => {
    const { outcome, reverse, markReconciling } = await handle(new Error('Could not serialize access due to concurrent update'));
    expect(reverse).not.toHaveBeenCalled();
    expect(markReconciling).toHaveBeenCalled();
    expect((outcome as { status: TxStatus }).status).toBe(TxStatus.RECONCILING);
  });

  it('a refusal after an earlier step already went out does not refund the whole trade', async () => {
    const { outcome, reverse } = await handle(new QuidaxError('Amount below minimum', null, 422), 1);
    expect(reverse).not.toHaveBeenCalled();
    expect((outcome as { status: TxStatus }).status).toBe(TxStatus.RECONCILING);
  });
});
