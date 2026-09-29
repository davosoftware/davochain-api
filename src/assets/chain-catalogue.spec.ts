import { CHAIN_CATALOGUE, requiresTag, seedNetworksFor } from './chain-catalogue';

/** The fifteen coins in prisma/seed.ts. Kept in step deliberately. */
const LISTED = [
  'btc',
  'usdt',
  'usdc',
  'eth',
  'bnb',
  'xrp',
  'ltc',
  'sol',
  'bch',
  'doge',
  'trx',
  'pol',
  'link',
  'ada',
  'sui',
];

describe('chain catalogue — every listed coin is deposit-able', () => {
  it.each(LISTED)('%s has at least one chain', (code) => {
    expect(seedNetworksFor(code).length).toBeGreaterThan(0);
  });

  it.each(LISTED)('%s has exactly one default chain', (code) => {
    const defaults = seedNetworksFor(code).filter((n) => n.isDefault);
    expect(defaults).toHaveLength(1);
  });

  it.each(LISTED)('%s can be deposited on its default chain', (code) => {
    const fallback = seedNetworksFor(code).find((n) => n.isDefault)!;
    expect(fallback.deposits).toBe(true);
  });

  it('has no duplicate network ids within a coin', () => {
    for (const [code, nets] of Object.entries(CHAIN_CATALOGUE)) {
      const ids = nets.map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe('stablecoins carry their full chain surface', () => {
  it('USDT has all ten networks', () => {
    const ids = seedNetworksFor('usdt')
      .map((n) => n.id)
      .sort();
    expect(ids).toEqual(
      [
        'arbitrum',
        'bep20',
        'celo',
        'erc20',
        'lisk',
        'optimism',
        'polygon',
        'solana',
        'ton network',
        'trc20',
      ].sort(),
    );
  });

  it('USDC has all seven networks', () => {
    expect(seedNetworksFor('usdc')).toHaveLength(7);
    const ids = seedNetworksFor('usdc').map((n) => n.id);
    expect(ids).toEqual(
      expect.arrayContaining(['erc20', 'bep20', 'polygon', 'solana', 'arbitrum', 'base', 'lisk']),
    );
  });

  it('marks USDT on Arbitrum deposit-only — the API says so, no doc page does', () => {
    const arb = seedNetworksFor('usdt').find((n) => n.id === 'arbitrum')!;
    expect(arb.deposits).toBe(true);
    expect(arb.withdraws).toBe(false);
  });

  it('every stablecoin chain accepts deposits', () => {
    for (const code of ['usdt', 'usdc']) {
      for (const net of seedNetworksFor(code)) {
        expect(net.deposits).toBe(true);
      }
    }
  });
});

describe('destination tags — a missing memo loses the deposit', () => {
  it('flags XRP, whose network Quidax calls "ripple" rather than "xrp"', () => {
    const xrp = seedNetworksFor('xrp');
    expect(xrp[0].id).toBe('ripple');
    expect(xrp[0].requiresTag).toBe(true);
  });

  it('flags TON on USDT', () => {
    const ton = seedNetworksFor('usdt').find((n) => n.id === 'ton network')!;
    expect(ton.requiresTag).toBe(true);
  });

  it('matches on the asset code AND on the network id', () => {
    expect(requiresTag('xrp', 'anything')).toBe(true); // by code
    expect(requiresTag('usdt', 'ton network')).toBe(true); // by network
    expect(requiresTag('usdt', 'trc20')).toBe(false);
    expect(requiresTag('btc', 'btc')).toBe(false);
  });

  it('is case-insensitive on both sides', () => {
    expect(requiresTag('XRP', 'RIPPLE')).toBe(true);
    expect(requiresTag('USDT', 'TON Network')).toBe(true);
  });
});

describe('chain ids match what Quidax actually returns', () => {
  it('never uses the coin code as a stand-in network id', () => {
    // The bug this guards: a placeholder chain named after the coin, which
    // makes every id-keyed rule (the tag rule above) match against fiction.
    for (const [code, nets] of Object.entries(CHAIN_CATALOGUE)) {
      // Native chains legitimately share the name (btc/btc, ltc/ltc, doge/doge).
      const nativeChains = ['btc', 'ltc', 'bch', 'doge', 'sui'];
      if (nativeChains.includes(code)) continue;
      expect(nets.map((n) => n.id)).not.toContain(code);
    }
  });

  it('uses pol, never matic — the docs table is stale', () => {
    expect(CHAIN_CATALOGUE['matic']).toBeUndefined();
    expect(seedNetworksFor('pol').length).toBeGreaterThan(0);
  });

  it('uses cardano for ADA and ripple for XRP', () => {
    expect(seedNetworksFor('ada')[0].id).toBe('cardano');
    expect(seedNetworksFor('xrp')[0].id).toBe('ripple');
  });

  it('returns an empty list for an unknown coin rather than throwing', () => {
    expect(seedNetworksFor('notacoin')).toEqual([]);
  });
});
