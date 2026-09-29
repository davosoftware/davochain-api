import { Decimal, dec, deviationBps, floorToStep, minTradeUsd } from './money';

describe('floorToStep — precision is the note size', () => {
  it('rounds a $10 BTC buy down onto an 8-decimal step', () => {
    // $10 / $103,000 = 0.00009708737864…
    const owed = dec(10).div(103_000);
    const sent = floorToStep(owed, '0.00000001');
    expect(sent.toFixed()).toBe('0.00009708');
    // Error under 0.01% — invisible.
    expect(owed.minus(sent).div(owed).mul(100).toNumber()).toBeLessThan(0.01);
  });

  it('shows why a 5-decimal step would be unshippable at a $10 minimum', () => {
    const owed = dec(10).div(103_000);
    const sent = floorToStep(owed, '0.00001');
    expect(sent.toFixed()).toBe('0.00009'); // = $9.27, not $10
    const lossPct = owed.minus(sent).div(owed).mul(100).toNumber();
    expect(lossPct).toBeGreaterThan(7); // 7.3% — the reason we measure the step
  });

  it('never rounds up — the house must not pay the difference', () => {
    for (const amount of ['0.000199999', '1.99999999999', '0.1']) {
      const sent = floorToStep(amount, '0.0001');
      expect(sent.lte(dec(amount))).toBe(true);
    }
  });

  it('passes the amount through when no step is known', () => {
    expect(floorToStep('1.23456789', null).toFixed()).toBe('1.23456789');
  });
});

describe('minTradeUsd — three constraints, highest wins', () => {
  it('lets the commercial floor govern when precision is generous', () => {
    // ETH: transfer min 0.001 ≈ $3.90, step tiny.
    const min = minTradeUsd({ floorUsd: 10, stepUsd: '0.001', transferMinUsd: '3.90' });
    expect(min.toNumber()).toBe(10);
  });

  it("lifts BTC above the floor because Quidax's transfer minimum binds", () => {
    // BTC: 0.00015 ≈ $15 at $100k. 1.2 × 15 = 18.
    const min = minTradeUsd({ floorUsd: 10, stepUsd: '0.001', transferMinUsd: '15' });
    expect(min.toNumber()).toBe(18);
  });

  it('moves with the price, because the limit is denominated in coin', () => {
    const at100k = minTradeUsd({ floorUsd: 10, transferMinUsd: dec('0.00015').mul(100_000) });
    const at200k = minTradeUsd({ floorUsd: 10, transferMinUsd: dec('0.00015').mul(200_000) });
    expect(at100k.toNumber()).toBe(18);
    expect(at200k.toNumber()).toBe(36);
    expect(at200k.gt(at100k)).toBe(true); // never cache this value
  });

  it('lets a coarse step lift the minimum on its own', () => {
    const min = minTradeUsd({ floorUsd: 5, stepUsd: '1.03', transferMinUsd: '1' });
    expect(min.toNumber()).toBe(103);
  });
});

describe('the gate — one number per coin, added on buy, subtracted on sell', () => {
  const R_QX = dec(1430);
  const GATE = dec(20);

  it('earns exactly the gate on a buy, matching the worked example', () => {
    const rBuy = R_QX.plus(GATE); // 1450
    const naira = dec(97_150);
    const usd = naira.div(rBuy);
    expect(usd.toFixed(2)).toBe('67.00');
    // Margin = usd × gate = 67 × 20 = ₦1,340
    expect(usd.mul(GATE).toFixed(0)).toBe('1340');
  });

  it('mirrors on a sell', () => {
    const rSell = R_QX.minus(GATE); // 1410
    const usd = dec(67);
    const gross = usd.mul(rSell);
    const treasuryProceeds = usd.mul(R_QX);
    expect(treasuryProceeds.minus(gross).toFixed(0)).toBe('1340');
  });

  it('is about 1.4% — which a major coin can cover in an afternoon', () => {
    expect(GATE.div(R_QX).mul(100).toNumber()).toBeCloseTo(1.4, 1);
  });
});

describe('deviationBps — the margin trip', () => {
  it('reports zero when realised matches expected', () => {
    expect(deviationBps(1450, 1450).toNumber()).toBe(0);
  });

  it('trips at 200bps for a 2% shortfall', () => {
    expect(deviationBps(1421, 1450).toNumber()).toBeCloseTo(200, 0);
  });

  it('is direction-agnostic — a suspiciously good fill is also a bug', () => {
    expect(deviationBps(1479, 1450).toNumber()).toBeCloseTo(200, 0);
  });
});

describe('Decimal discipline', () => {
  it('survives arithmetic that destroys a float', () => {
    expect(dec('0.1').plus('0.2').equals(new Decimal('0.3'))).toBe(true);
    expect(0.1 + 0.2 === 0.3).toBe(false); // why the rule exists
  });

  it('keeps satoshi precision through a round trip', () => {
    const sats = '0.00000001';
    expect(dec(sats).mul(100_000_000).toFixed()).toBe('1');
  });
});
