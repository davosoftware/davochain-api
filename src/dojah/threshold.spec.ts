import { dojahThresholds } from './threshold';

describe('dojahThresholds (plan §R2)', () => {
  it('reproduces the worked example', () => {
    const r = dojahThresholds({ lookupPrice: 100, amlPrice: 150, peakHour: 15, peakDay: 120, leadDays: 3 });
    expect(r.perVerification).toBe(400);
    expect(r.minBalance).toBe(8000);
    expect(r.lowBalanceWarn).toBe(152000);
  });

  it('uses the real hourly peak when it is above 20', () => {
    expect(dojahThresholds({ lookupPrice: 100, amlPrice: 150, peakHour: 37, peakDay: 120, leadDays: 3 }).minBalance).toBe(14800);
  });

  it('rounds up to the next ₦100, never down', () => {
    const r = dojahThresholds({ lookupPrice: 33.33, amlPrice: 10, peakHour: 1, peakDay: 1, leadDays: 1 });
    // C = 53.33; MIN = 53.33 × 20 = 1066.6 → 1100; WARN = 1100 + roundUp100(53.33) = 1100 + 100
    expect(r.minBalance).toBe(1100);
    expect(r.lowBalanceWarn).toBe(1200);
  });

  it('refuses missing, zero or negative prices and volumes', () => {
    expect(() => dojahThresholds({ lookupPrice: 0, amlPrice: 150, peakHour: 1, peakDay: 1, leadDays: 1 })).toThrow(/lookupPrice/);
    expect(() => dojahThresholds({ lookupPrice: 100, amlPrice: Number.NaN, peakHour: 1, peakDay: 1, leadDays: 1 })).toThrow(/amlPrice/);
    expect(() => dojahThresholds({ lookupPrice: 100, amlPrice: 150, peakHour: 1, peakDay: 0, leadDays: 1 })).toThrow(/peakDay/);
  });

  it('shows its arithmetic', () => {
    const r = dojahThresholds({ lookupPrice: 100, amlPrice: 150, peakHour: 15, peakDay: 120, leadDays: 3 });
    expect(r.workings.join('\n')).toContain('C = 100 + 2 × 150 = 400');
  });
});

describe('dojahThresholds with Advanced (spec §12)', () => {
  it('adds four Advanced calls per verification when an Advanced price is given', () => {
    const r = dojahThresholds({ lookupPrice: 100, amlPrice: 50, advancedPrice: 25, peakHour: 1, peakDay: 1, leadDays: 3 });
    expect(r.perVerification).toBe(300); // 100 + 2×50 + 4×25
  });
});
