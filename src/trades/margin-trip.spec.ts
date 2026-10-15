import { AlertType } from '@prisma/client';
import { dec } from '../common/money';

/**
 * H10 (PROJECT_REVIEW): MARGIN_DEVIATION_TRIP_BPS was validated and never read,
 * so a stale or bad price from Quidax tripped nothing. Now, when what Quidax
 * actually executes is worse than what we quoted by more than the trip (2%),
 * trading in those coins pauses and staff are told. The trade in hand has
 * already happened and completes.
 */
async function trades() {
  const { TradesService } = await import('./trades.service');
  const paused: string[] = [];
  const svc = Object.create(TradesService.prototype) as Record<string, unknown>;
  const alerts = { raise: jest.fn(async () => true) };
  Object.assign(svc, {
    flags: { pauseAsset: jest.fn(async (code: string) => paused.push(code)) },
    alerts,
    config: { get: (k: string) => ({ MARGIN_DEVIATION_TRIP_BPS: 200 })[k] },
  });
  const trip = (svc.tripIfWorse as (...a: unknown[]) => Promise<boolean>).bind(svc);
  return { trip, paused, alerts };
}

describe('H10: the margin trip', () => {
  it('a swap that gives 1% less than quoted is within tolerance', async () => {
    const { trip, paused } = await trades();
    expect(await trip({ expected: dec('10'), actual: dec('9.9'), worseWhen: 'less', assets: ['btc', 'eth'], tx: 'tx1' })).toBe(false);
    expect(paused).toEqual([]);
  });

  it('a swap that gives 3% less than quoted pauses both coins and alerts staff', async () => {
    const { trip, paused, alerts } = await trades();
    expect(await trip({ expected: dec('10'), actual: dec('9.7'), worseWhen: 'less', assets: ['btc', 'eth'], tx: 'tx1' })).toBe(true);
    expect(paused).toEqual(['btc', 'eth']);
    expect(alerts.raise).toHaveBeenCalledWith(AlertType.PRICE_DIP, expect.stringContaining('margin-trip'), expect.any(String), expect.any(Array));
  });

  it('a fallback buy that costs us 3% more naira than the customer paid pauses the coin', async () => {
    const { trip, paused } = await trades();
    expect(await trip({ expected: dec('100000'), actual: dec('103000'), worseWhen: 'more', assets: ['btc'], tx: 'tx2' })).toBe(true);
    expect(paused).toEqual(['btc']);
  });

  it('a better-than-quoted result never trips', async () => {
    const { trip, paused } = await trades();
    expect(await trip({ expected: dec('10'), actual: dec('11'), worseWhen: 'less', assets: ['btc'], tx: 'tx3' })).toBe(false);
    expect(await trip({ expected: dec('100000'), actual: dec('90000'), worseWhen: 'more', assets: ['btc'], tx: 'tx4' })).toBe(false);
    expect(paused).toEqual([]);
  });
});

describe('H10: a swap checks the margin after Quidax executes it', () => {
  it('the swap calls the trip with Quidax’s amount against the quoted gross', async () => {
    const { TradesService } = await import('./trades.service');
    const svc = Object.create(TradesService.prototype) as Record<string, unknown>;
    const tripIfWorse = jest.fn(async () => false);
    Object.assign(svc, {
      tripIfWorse,
      flags: { assertTradingAllowed: jest.fn(async () => undefined) },
      settlement: {
        quidaxIdFor: jest.fn(async () => 'sub1'),
        swapInSubAccount: jest.fn(async () => ({ id: 'sw1', status: 'initiated', received_amount: '9.7', from_amount: '0.5' })),
      },
      ledger: { lock: jest.fn() },
      quidax: { newReference: () => 'ref' },
      policy: { fx: async () => ({ ngnPerUsd: dec('1500') }), assertWithinLimits: async () => undefined },
      prisma: { serializable: jest.fn(async () => ({ id: 'tx3' })), transaction: { update: jest.fn(async () => ({})) } },
    });
    const swap = (svc.swap as (...a: unknown[]) => Promise<unknown>).bind(svc);
    await swap('u1', {
      id: 'q1', fromAsset: 'btc', toAsset: 'eth', fromAmount: '0.5', toAmount: '9.98', displayedRate: '20',
      usdValue: '1000', feeUsd: null, feeAmount: '0.02', feeAsset: 'eth', rateConfigId: 'cfg1',
    });
    expect(tripIfWorse).toHaveBeenCalledWith(
      expect.objectContaining({ worseWhen: 'less', assets: ['btc', 'eth'], tx: 'tx3' }),
    );
    const call = (tripIfWorse.mock.calls[0] as unknown as [{ expected: { toFixed(): string }; actual: { toFixed(): string } }])[0];
    expect(call.expected.toFixed()).toBe('10');
    expect(call.actual.toFixed()).toBe('9.7');
  });
});
