import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CredentialsService } from '../common/credentials.service';
import { randomUUID } from 'node:crypto';
import { QuidaxClient } from './quidax.client';
import { QuidaxError } from './quidax.errors';
import { requiresTag, seedNetworksFor } from '../assets/chain-catalogue';
import type {
  QuidaxPaymentAddress,
  QuidaxSwapQuotation,
  QuidaxSwapTransaction,
  QuidaxUser,
  QuidaxWallet,
  QuidaxWithdrawal,
} from './quidax.types';

/**
 * Fixture-backed stand-in for the live API.
 *
 * This exists because Quidax has no sandbox: without it, every test run moves
 * real money and a developer's loop can rate-limit real users. It reproduces
 * the behaviours that actually bite:
 *
 *   • createPaymentAddress returns address:null (generation is async)
 *   • confirmSwap returns status:"initiated", not "completed"
 *   • internal transfers are free, synchronous, status:"done"
 *   • transfer minimums are enforced and rejected the way Quidax rejects them
 */
@Injectable()
export class QuidaxMockClient extends QuidaxClient {
  private readonly mockLog = new Logger(QuidaxMockClient.name);

  /** Published internal-withdrawal limits. Both directions. */
  private static readonly TRANSFER_MIN: Record<string, string> = {
    bnb: '0.0035',
    btc: '0.00015',
    cngn: '1',
    eth: '0.001',
    ltc: '0.001',
    ngn: '1',
    sol: '0.005',
    ton: '1',
    usdc: '1',
    usdt: '1',
    xlm: '1',
    xrp: '1',
  };

  private static readonly TRANSFER_MAX: Record<string, string> = {
    bnb: '1000',
    btc: '2',
    cngn: '100000000',
    eth: '100',
    ltc: '1000',
    ngn: '500000000',
    sol: '100000',
    ton: '100000',
    usdc: '1000000',
    usdt: '1000000',
    xlm: '100000',
    xrp: '100000',
  };

  /** Indicative USD prices. Enough for deterministic tests, not a price feed. */
  private static readonly PRICE_USD: Record<string, number> = {
    btc: 103_000,
    eth: 3_900,
    bnb: 600,
    sol: 200,
    xrp: 2.1,
    ltc: 100,
    bch: 480,
    doge: 0.16,
    trx: 0.24,
    pol: 0.42,
    link: 18,
    ada: 0.85,
    sui: 3.2,
    usdt: 1,
    usdc: 1,
    ngn: 1 / 1445,
  };

  private static readonly NGN_PER_USD = 1445;

  /**
   * Quidax treats "me" as an alias for the merchant account, so both must
   * resolve to the SAME wallet. Keying them separately meant a fallback swap
   * credited "me" while the transfer read "mainacct" and found it empty — every
   * fallback buy failed locally while working fine against the live API, which
   * is the worst kind of mock bug.
   */
  private static readonly MAIN_ID = 'mainacct';

  private static key(userId: string): string {
    return userId === 'me' ? QuidaxMockClient.MAIN_ID : userId;
  }

  private readonly wallets = new Map<string, Map<string, string>>();
  private readonly quotations = new Map<string, QuidaxSwapQuotation>();
  private readonly addresses = new Map<string, QuidaxPaymentAddress>();

  constructor(config: ConfigService, credentials: CredentialsService) {
    super(config, credentials);
    this.mockLog.warn('QUIDAX_USE_MOCK=true — no live calls will be made');
    this.seedTreasury();
  }

  // ── helpers ─────────────────────────────────────────────────

  private price(currency: string): number {
    return QuidaxMockClient.PRICE_USD[currency.toLowerCase()] ?? 1;
  }

  private balance(userId: string, currency: string): number {
    return Number(
      this.wallets.get(QuidaxMockClient.key(userId))?.get(currency.toLowerCase()) ?? '0',
    );
  }

  private setBalance(userId: string, currency: string, amount: number): void {
    const k = QuidaxMockClient.key(userId);
    if (!this.wallets.has(k)) this.wallets.set(k, new Map());
    this.wallets.get(k)!.set(currency.toLowerCase(), String(Math.max(0, amount)));
  }

  /** Seed a wallet so a test can spend from it. */
  seed(userId: string, currency: string, amount: number): void {
    this.setBalance(userId, currency, amount);
  }

  /**
   * A treasury with something in it, so both settlement paths work locally:
   * inventory covers the normal path, and the naira funds the fallback swap
   * once a coin runs out.
   */
  private seedTreasury(): void {
    const inventory: Record<string, number> = {
      btc: 0.5, eth: 10, bnb: 50, sol: 200, xrp: 10_000, ltc: 100,
      bch: 50, doge: 200_000, trx: 100_000, pol: 50_000, link: 1_000,
      ada: 20_000, sui: 5_000, usdt: 50_000, usdc: 50_000,
    };
    for (const [code, amount] of Object.entries(inventory)) {
      this.setBalance(QuidaxMockClient.MAIN_ID, code, amount);
    }
    this.setBalance(QuidaxMockClient.MAIN_ID, 'ngn', 200_000_000);
  }

  private assertTransferLimits(currency: string, amount: string): void {
    const c = currency.toLowerCase();
    const min = QuidaxMockClient.TRANSFER_MIN[c];
    const max = QuidaxMockClient.TRANSFER_MAX[c];
    const value = Number(amount);
    if (min && value < Number(min)) {
      throw new QuidaxError(
        `Amount is below the minimum internal withdrawal for ${c.toUpperCase()} (${min})`,
        'E0605',
        400,
      );
    }
    if (max && value > Number(max)) {
      throw new QuidaxError(
        `Amount exceeds the maximum internal withdrawal for ${c.toUpperCase()} (${max})`,
        'E0606',
        400,
      );
    }
  }

  private user(id: string, email = 'mock@davochain.test'): QuidaxUser {
    return {
      id,
      sn: `QDXMOCK${id.slice(0, 6).toUpperCase()}`,
      email,
      reference: null,
      first_name: 'Mock',
      last_name: 'User',
      display_name: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  // ── accounts ────────────────────────────────────────────────

  override async fetchMainAccount(): Promise<QuidaxUser> {
    return this.user(QuidaxMockClient.MAIN_ID, 'merchant@davochain.test');
  }

  override async createSubAccount(input: {
    email: string;
    first_name: string;
    last_name: string;
  }): Promise<QuidaxUser> {
    const id = randomUUID().slice(0, 8);
    return {
      ...this.user(id, input.email),
      first_name: input.first_name,
      last_name: input.last_name,
    };
  }

  override async fetchSubAccount(userId: string): Promise<QuidaxUser> {
    return this.user(userId);
  }

  // ── wallets ─────────────────────────────────────────────────

  override async fetchWallet(currency: string, userId = 'me'): Promise<QuidaxWallet> {
    const c = currency.toLowerCase();
    const seeded = seedNetworksFor(c);
    return {
      id: `${userId}-${c}`,
      name: c.toUpperCase(),
      currency: c,
      balance: String(this.balance(userId, c)),
      locked: '0',
      staked: '0',
      converted_balance: '0',
      reference_currency: 'ngn',
      is_crypto: c !== 'ngn',
      blockchain_enabled: c !== 'ngn',
      // Real per-coin chains from the shared catalogue, so the mock exercises
      // the same ids production will see — "ripple" for XRP, ten networks for
      // USDT, seven for USDC — rather than one invented chain per coin.
      default_network: seeded.find((n) => n.isDefault)?.id ?? seeded[0]?.id ?? c,
      networks: seeded.map((n) => ({
        id: n.id,
        name: n.label,
        deposits_enabled: n.deposits,
        withdraws_enabled: n.withdraws,
      })),
      deposit_address: null,
      destination_tag: null,
    };
  }

  override async fetchWallets(userId = 'me'): Promise<QuidaxWallet[]> {
    const codes = Object.keys(QuidaxMockClient.PRICE_USD);
    return Promise.all(codes.map((c) => this.fetchWallet(c, userId)));
  }

  // ── addresses ───────────────────────────────────────────────

  override async createPaymentAddress(
    userId: string,
    currency: string,
    network?: string,
  ): Promise<QuidaxPaymentAddress> {
    const id = randomUUID();
    const record: QuidaxPaymentAddress = {
      id,
      reference: null,
      currency: currency.toLowerCase(),
      address: null, // async — mirrors the real API
      network: network ?? currency.toLowerCase(),
      destination_tag: null,
      total_payments: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.addresses.set(id, record);

    // Resolve shortly after, as the real webhook would.
    setTimeout(() => {
      const needsTag = requiresTag(currency, network ?? currency);
      this.addresses.set(id, {
        ...record,
        address: `mock_${currency.toLowerCase()}_${id.slice(0, 12)}`,
        destination_tag: needsTag ? String(100000 + Math.floor(Math.random() * 899999)) : null,
      });
    }, 250);

    return record;
  }

  override async fetchPaymentAddresses(
    _userId: string,
    currency: string,
  ): Promise<QuidaxPaymentAddress[]> {
    return [...this.addresses.values()].filter(
      (a) => a.currency === currency.toLowerCase() && a.address !== null,
    );
  }

  // ── pricing & swaps ─────────────────────────────────────────

  private quote(
    from: string,
    to: string,
    fromAmount?: string,
    toAmount?: string,
  ): QuidaxSwapQuotation {
    const f = from.toLowerCase();
    const t = to.toLowerCase();
    const fUsd = this.price(f);
    const tUsd = this.price(t);
    // ~0.4% against us, the way a retail instant-swap book quotes.
    const rate = (fUsd / tUsd) * 0.996;

    const fromAmt = fromAmount ? Number(fromAmount) : Number(toAmount) / rate;
    const toAmt = toAmount ? Number(toAmount) : fromAmt * rate;

    const id = randomUUID().replace(/-/g, '');
    const q: QuidaxSwapQuotation = {
      id,
      confirmed: false,
      from_currency: f.toUpperCase(),
      to_currency: t.toUpperCase(),
      quoted_price: String(rate),
      quoted_currency: t.toUpperCase(),
      from_amount: fromAmt.toFixed(18),
      to_amount: toAmt.toFixed(18),
      expires_at: new Date(Date.now() + 15_000).toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.quotations.set(id, q);
    return q;
  }

  override async temporaryQuotation(
    _userId: string,
    input: { from_currency: string; to_currency: string; from_amount?: string; to_amount?: string },
  ): Promise<QuidaxSwapQuotation> {
    return this.quote(input.from_currency, input.to_currency, input.from_amount, input.to_amount);
  }

  override async createSwapQuotation(
    _userId: string,
    input: { from_currency: string; to_currency: string; from_amount?: string; to_amount?: string },
  ): Promise<QuidaxSwapQuotation> {
    return this.quote(input.from_currency, input.to_currency, input.from_amount, input.to_amount);
  }

  override async confirmSwap(userId: string, quotationId: string): Promise<QuidaxSwapTransaction> {
    const q = this.quotations.get(quotationId);
    if (!q) {
      throw new QuidaxError(
        'Unable to confirm quotation: Reason: Quotation used or expired',
        'E0107',
        400,
      );
    }
    if (new Date(q.expires_at).getTime() < Date.now()) {
      this.quotations.delete(quotationId);
      throw new QuidaxError(
        'Unable to confirm quotation: Reason: Quotation used or expired',
        'E0107',
        400,
      );
    }
    this.quotations.delete(quotationId); // single use

    const from = q.from_currency.toLowerCase();
    const to = q.to_currency.toLowerCase();
    this.setBalance(userId, from, this.balance(userId, from) - Number(q.from_amount));
    this.setBalance(userId, to, this.balance(userId, to) + Number(q.to_amount));

    return {
      id: randomUUID(),
      from_currency: q.from_currency,
      to_currency: q.to_currency,
      from_amount: q.from_amount,
      received_amount: q.to_amount,
      execution_price: q.quoted_price,
      status: 'initiated', // NOT completed — completion arrives separately
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      swap_quotation: { ...q, confirmed: true },
    };
  }

  override async fetchSwapTransactions(): Promise<QuidaxSwapTransaction[]> {
    return [];
  }

  // ── transfers ───────────────────────────────────────────────

  override async internalTransfer(
    fromUserId: string,
    input: { currency: string; amount: string; fund_uid: string; reference: string },
  ): Promise<QuidaxWithdrawal> {
    this.assertTransferLimits(input.currency, input.amount);

    const c = input.currency.toLowerCase();
    const amount = Number(input.amount);
    if (this.balance(fromUserId, c) < amount) {
      throw new QuidaxError('Insufficient balance', 'E0300', 400);
    }
    this.setBalance(fromUserId, c, this.balance(fromUserId, c) - amount);
    this.setBalance(input.fund_uid, c, this.balance(input.fund_uid, c) + amount);

    return {
      id: `IW-${randomUUID().replace(/-/g, '')}`,
      reference: input.reference,
      type: 'internal',
      currency: c,
      amount: input.amount,
      fee: '0.0',
      total: input.amount,
      status: 'done', // free, synchronous, final
      created_at: new Date().toISOString(),
      done_at: new Date().toISOString(),
    };
  }

  override async createCryptoWithdrawal(
    userId: string,
    input: { currency: string; amount: string; reference: string; [k: string]: unknown },
  ): Promise<QuidaxWithdrawal> {
    const c = input.currency.toLowerCase();
    this.setBalance(userId, c, this.balance(userId, c) - Number(input.amount));
    return {
      id: `CW-${randomUUID().replace(/-/g, '')}`,
      reference: input.reference,
      type: 'coin_address',
      currency: c,
      amount: input.amount,
      fee: '0.0005',
      total: String(Number(input.amount) + 0.0005),
      status: 'processing',
      created_at: new Date().toISOString(),
      done_at: null,
    };
  }

  override async fetchWithdrawals(): Promise<QuidaxWithdrawal[]> {
    return [];
  }

  override async fetchWithdrawalByReference(): Promise<QuidaxWithdrawal | null> {
    return null;
  }

  override async fetchWithdrawalFee(input: {
    currency: string;
  }): Promise<{ fee: number; type: string }> {
    const flat: Record<string, number> = { btc: 0.0002, eth: 0.002, usdt: 1, usdc: 1 };
    return { fee: flat[input.currency.toLowerCase()] ?? 0.001, type: 'flat' };
  }

  override async fetchAllSubUserDeposits(): Promise<never[]> {
    return [];
  }
}
