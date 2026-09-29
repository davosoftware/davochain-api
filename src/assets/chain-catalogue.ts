/**
 * Provisional chain list per coin.
 *
 * This is a STARTING POINT so a fresh install has usable deposit chains before
 * anything has talked to Quidax. It is not authoritative and must not be
 * treated as such — `AssetsService.syncNetworks()` overwrites every row from
 * `GET /users/me/wallets/{currency}` -> networks[], which is the only source
 * that carries `deposits_enabled` / `withdraws_enabled`.
 *
 * Rows seeded from here get `syncedAt: null` so it is visible at a glance which
 * chains have been verified against the live API and which have not.
 *
 * Sources, in order of trust:
 *   1. Live API responses (USDT — matches /docs/supported-stablecoins exactly)
 *   2. /docs/supported-stablecoins  (current)
 *   3. /docs/supported-cryptocurrencies  (STALE — it lists USDT on three
 *      networks when the real answer is ten, and still calls Polygon "matic")
 */

export interface SeedNetwork {
  id: string;
  label: string;
  deposits: boolean;
  withdraws: boolean;
  isDefault?: boolean;
  /** A deposit without the memo lands in the omnibus, not the user's account. */
  requiresTag?: boolean;
  confirmations?: number;
}

/**
 * Chains that need a destination tag or memo. Matched against BOTH the network
 * id and the asset code, because Quidax names them inconsistently — XRP's
 * network comes back as "ripple", Stellar's as "stellar".
 */
export const TAG_REQUIRED = new Set([
  'xrp',
  'ripple',
  'xlm',
  'stellar',
  'ton',
  'ton network',
  'atom',
  'cosmos',
]);

export const CHAIN_CATALOGUE: Record<string, SeedNetwork[]> = {
  // ── stablecoins: the widest surface, and the most used ──────
  // Ten networks, confirmed against a live wallet response.
  usdt: [
    { id: 'bep20', label: 'Binance Smart Chain', deposits: true, withdraws: true, isDefault: true },
    { id: 'trc20', label: 'Tron Network', deposits: true, withdraws: true },
    { id: 'erc20', label: 'Ethereum Network', deposits: true, withdraws: true, confirmations: 12 },
    { id: 'polygon', label: 'Polygon Network', deposits: true, withdraws: true },
    { id: 'solana', label: 'Solana Network', deposits: true, withdraws: true },
    { id: 'ton network', label: 'Ton Network', deposits: true, withdraws: true, requiresTag: true },
    { id: 'celo', label: 'CELO', deposits: true, withdraws: true },
    { id: 'optimism', label: 'OP Mainnet', deposits: true, withdraws: true },
    // Deposit-only today. Nothing in the docs says so — only the API does.
    { id: 'arbitrum', label: 'Arbitrum One', deposits: true, withdraws: false },
    { id: 'lisk', label: 'LISK', deposits: true, withdraws: true },
  ],
  usdc: [
    { id: 'erc20', label: 'Ethereum Network', deposits: true, withdraws: true, confirmations: 12 },
    { id: 'bep20', label: 'Binance Smart Chain', deposits: true, withdraws: true, isDefault: true },
    { id: 'polygon', label: 'Polygon Network', deposits: true, withdraws: true },
    { id: 'solana', label: 'Solana Network', deposits: true, withdraws: true },
    { id: 'arbitrum', label: 'Arbitrum One', deposits: true, withdraws: true },
    { id: 'base', label: 'Base', deposits: true, withdraws: true },
    { id: 'lisk', label: 'LISK', deposits: true, withdraws: true },
  ],

  // ── native chains ───────────────────────────────────────────
  btc: [
    {
      id: 'btc',
      label: 'Bitcoin Network',
      deposits: true,
      withdraws: true,
      isDefault: true,
      confirmations: 2,
    },
  ],
  ltc: [
    {
      id: 'ltc',
      label: 'Litecoin Network',
      deposits: true,
      withdraws: true,
      isDefault: true,
      confirmations: 6,
    },
  ],
  bch: [
    {
      id: 'bch',
      label: 'Bitcoin Cash Network',
      deposits: true,
      withdraws: true,
      isDefault: true,
      confirmations: 6,
    },
  ],
  doge: [
    {
      id: 'doge',
      label: 'Dogecoin Network',
      deposits: true,
      withdraws: true,
      isDefault: true,
      confirmations: 20,
    },
  ],
  ada: [
    {
      id: 'cardano',
      label: 'Cardano Network',
      deposits: true,
      withdraws: true,
      isDefault: true,
      confirmations: 15,
    },
  ],
  sui: [{ id: 'sui', label: 'Sui Network', deposits: true, withdraws: true, isDefault: true }],
  trx: [{ id: 'trc20', label: 'Tron Network', deposits: true, withdraws: true, isDefault: true }],

  // Destination tag is mandatory — without it the deposit is lost.
  xrp: [
    {
      id: 'ripple',
      label: 'Ripple Network',
      deposits: true,
      withdraws: true,
      isDefault: true,
      requiresTag: true,
    },
  ],

  // ── multi-chain tokens ──────────────────────────────────────
  eth: [
    {
      id: 'erc20',
      label: 'Ethereum Network',
      deposits: true,
      withdraws: true,
      isDefault: true,
      confirmations: 12,
    },
    { id: 'bep20', label: 'Binance Smart Chain', deposits: true, withdraws: true },
  ],
  bnb: [
    { id: 'bep20', label: 'Binance Smart Chain', deposits: true, withdraws: true, isDefault: true },
  ],
  pol: [
    { id: 'polygon', label: 'Polygon Network', deposits: true, withdraws: true, isDefault: true },
    { id: 'bep20', label: 'Binance Smart Chain', deposits: true, withdraws: true },
    { id: 'erc20', label: 'Ethereum Network', deposits: true, withdraws: true, confirmations: 12 },
  ],
  sol: [
    { id: 'solana', label: 'Solana Network', deposits: true, withdraws: true, isDefault: true },
    { id: 'bep20', label: 'Binance Smart Chain', deposits: true, withdraws: true },
  ],
  link: [
    { id: 'erc20', label: 'Ethereum Network', deposits: true, withdraws: true, confirmations: 12 },
    { id: 'bep20', label: 'Binance Smart Chain', deposits: true, withdraws: true, isDefault: true },
  ],
};

export function seedNetworksFor(assetCode: string): SeedNetwork[] {
  return CHAIN_CATALOGUE[assetCode.toLowerCase()] ?? [];
}

export function requiresTag(assetCode: string, networkId: string): boolean {
  return TAG_REQUIRED.has(assetCode.toLowerCase()) || TAG_REQUIRED.has(networkId.toLowerCase());
}
