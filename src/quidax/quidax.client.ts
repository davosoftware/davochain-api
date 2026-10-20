import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CredentialsService } from '../common/credentials.service';
import { request } from 'undici';
import { ulid } from 'ulid';
import type Redis from 'ioredis';
import { TokenBucket } from './rate-limiter';
import { LaneBusyError, SharedTokenBucket } from './shared-bucket';
import { RATE_LIMIT_REDIS } from '../rate-limit/rate-limit.service';
import { QuidaxError, QuidaxRateLimitError, QuidaxUnknownError } from './quidax.errors';
import type {
  QuidaxDeposit,
  QuidaxBank,
  QuidaxEnvelope,
  QuidaxErrorBody,
  QuidaxFeeRule,
  QuidaxPage,
  QuidaxPaymentAddress,
  QuidaxSwapQuotation,
  QuidaxSwapTransaction,
  QuidaxUser,
  QuidaxVerifiedBankAccount,
  QuidaxWallet,
  QuidaxWithdrawal,
} from './quidax.types';

type Lane = 'default' | 'address' | 'background';

/**
 * M9: the longest a call may wait for its turn before it is refused as busy.
 * Short where a person is waiting on a screen, longer for background jobs.
 */
export const LANE_MAX_WAIT_MS: Readonly<Record<Lane, number>> = { default: 10_000, address: 10_000, background: 120_000 };

interface CallOpts {
  lane?: Lane;
  /** Idempotency key we sent upstream. Surfaces in QuidaxUnknownError for the reconciler. */
  reference?: string;
  /** Never retry a non-idempotent write on an ambiguous failure. */
  idempotent?: boolean;
  query?: Record<string, string | number | undefined | null>;
}

/**
 * The only thing in the codebase that talks to Quidax.
 *
 * Handles: bearer auth, the {status,message,data} envelope, typed errors,
 * retry with jitter, three rate-limit lanes, and header-based pagination.
 */
@Injectable()
export class QuidaxClient {
  private readonly log = new Logger(QuidaxClient.name);
  private readonly baseUrl: string;
  /**
   * The key in force at boot. Kept only as the fallback for the very first
   * call — CredentialsService is the source of truth, and it can change under
   * us when an admin rotates the key.
   */
  private readonly bootSecretKey: string;
  private readonly lanes: Record<Lane, SharedTokenBucket>;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    private readonly credentials: CredentialsService,
    /**
     * M9: with Redis, every API server shares one budget (Quidax counts per
     * API key, not per server). Without it (tests, scripts), each process
     * keeps its own count, as before.
     */
    @Optional() @Inject(RATE_LIMIT_REDIS) redis?: Redis | null,
  ) {
    this.baseUrl = this.config.getOrThrow<string>('QUIDAX_BASE_URL').replace(/\/+$/, '');
    this.bootSecretKey = this.config.get<string>('QUIDAX_SECRET_KEY') ?? '';
    const perMinute = (n: number) => n / 60_000;
    const perSecond = (n: number) => n / 1_000;
    const lane = (name: Lane, capacity: number, refillPerMs: number) =>
      new SharedTokenBucket(redis ?? null, `quidax:rl:${name}`, capacity, refillPerMs, new TokenBucket(capacity, refillPerMs, name));
    const def = this.config.get<number>('QUIDAX_RATE_LIMIT_PER_MINUTE') ?? 240;
    const addr = this.config.get<number>('QUIDAX_ADDRESS_RATE_LIMIT_PER_SECOND') ?? 15;
    const bg = this.config.get<number>('QUIDAX_BACKGROUND_RATE_LIMIT_PER_MINUTE') ?? 30;
    this.lanes = {
      default: lane('default', def, perMinute(def)),
      address: lane('address', addr, perSecond(addr)),
      background: lane('background', bg, perMinute(bg)),
    };
  }

  // ── transport ───────────────────────────────────────────────

  private async call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    opts: CallOpts = {},
  ): Promise<QuidaxPage<T>> {
    const lane = this.lanes[opts.lane ?? 'default'];
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    // Read once per call rather than once per process: an admin rotating the
    // key in the dashboard should not need a restart to make it stick. Cached
    // in the credentials service, so this is a map lookup after the first.
    const secretKey =
      (await this.credentials.get('quidax.secretKey').catch(() => undefined)) ??
      this.bootSecretKey;

    const maxAttempts = opts.idempotent === false ? 1 : 4;
    // A write that does not come back with a clear answer may have been carried
    // out anyway (C4). Same test as the network-failure branch below.
    const isWrite = opts.idempotent === false || method !== 'GET';
    const unknown = (why: string) =>
      new QuidaxUnknownError(`Quidax ${method} ${path} did not return a definite result: ${why}`, method, path, opts.reference);
    let lastRetryable: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // M9: refused BEFORE anything is sent. A write only ever gets a second
      // attempt after a 429 (nothing done), so "busy" always means nothing happened.
      try {
        await lane.take(LANE_MAX_WAIT_MS[opts.lane ?? 'default']);
      } catch (err) {
        if (err instanceof LaneBusyError) throw new QuidaxRateLimitError(429, err.retryAfterMs);
        throw err;
      }

      try {
        const res = await request(url.toString(), {
          method,
          headers: {
            authorization: `Bearer ${secretKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          headersTimeout: 20_000,
          bodyTimeout: 20_000,
        });

        const text = await res.body.text();

        // Throttled. Security page documents 444; errors page documents 429.
        if (res.statusCode === 429 || res.statusCode === 444) {
          const retryAfter = Number(res.headers['retry-after'] ?? 0) * 1000 || 2_000 * attempt;
          lastRetryable = new QuidaxRateLimitError(res.statusCode, retryAfter);
          if (attempt < maxAttempts) {
            await this.sleep(retryAfter + this.jitter());
            continue;
          }
          throw lastRetryable;
        }

        // C4: a server error or a timeout on a write is not a refusal. A gateway
        // can answer 502/504 after Quidax already committed the transfer.
        if (isWrite && (res.statusCode >= 500 || res.statusCode === 408)) {
          throw unknown(`HTTP ${res.statusCode}`);
        }

        let parsed: QuidaxEnvelope<T> | undefined;
        try {
          parsed = text ? (JSON.parse(text) as QuidaxEnvelope<T>) : undefined;
        } catch {
          // An HTML or empty page is not Quidax speaking: for a write, unknown.
          if (isWrite) throw unknown(`non-JSON response (${res.statusCode})`);
          throw new QuidaxError(
            `Non-JSON response from Quidax (${res.statusCode})`,
            null,
            res.statusCode,
            text.slice(0, 500),
          );
        }

        // Parse `status`, not the HTTP code — Quidax returns 200 with status:"error".
        if (!parsed || parsed.status === 'error') {
          const err = (parsed?.data ?? {}) as Partial<QuidaxErrorBody>;
          const quidaxError = new QuidaxError(
            err.message ?? parsed?.message ?? 'Quidax request failed',
            err.code ?? null,
            res.statusCode,
            parsed,
          );
          // 5xx is worth another go; a business rejection is not.
          if (res.statusCode >= 500 && attempt < maxAttempts) {
            lastRetryable = quidaxError;
            await this.sleep(this.backoff(attempt));
            continue;
          }
          throw quidaxError;
        }

        return {
          data: parsed.data,
          nextPage: this.header(res.headers['x-next-page']),
          totalPages: this.num(res.headers['x-total-pages']),
          perPage: this.num(res.headers['x-per-page']),
          page: this.num(res.headers['x-page']),
        };
      } catch (err) {
        if (err instanceof QuidaxError || err instanceof QuidaxUnknownError) throw err;

        // Network-level failure. For a write, we genuinely do not know whether
        // it landed — do not retry, hand it to the reconciler.
        if (opts.idempotent === false || method !== 'GET') {
          throw new QuidaxUnknownError(
            `Quidax ${method} ${path} did not return a definite result: ${(err as Error).message}`,
            method,
            path,
            opts.reference,
          );
        }
        lastRetryable = err as Error;
        if (attempt < maxAttempts) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw err;
      }
    }

    throw lastRetryable ?? new QuidaxError('Quidax request failed', null, 0);
  }

  private async get<T>(path: string, opts: CallOpts = {}): Promise<QuidaxPage<T>> {
    return this.call<T>('GET', path, undefined, opts);
  }

  private async post<T>(path: string, body?: unknown, opts: CallOpts = {}): Promise<T> {
    const page = await this.call<T>('POST', path, body, { idempotent: false, ...opts });
    return page.data;
  }

  private header(v: string | string[] | undefined): string | null {
    const s = Array.isArray(v) ? v[0] : v;
    return s && s.length > 0 ? s : null;
  }

  private num(v: string | string[] | undefined): number | null {
    const s = this.header(v);
    return s === null ? null : Number(s);
  }

  private backoff(attempt: number): number {
    return Math.min(8_000, 2 ** attempt * 250) + this.jitter();
  }

  private jitter(): number {
    return Math.floor(Math.random() * 250);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Walk every page of a list endpoint using the header cursor. */
  async *paginate<T>(path: string, opts: CallOpts = {}): AsyncGenerator<T, void, void> {
    let page: string | null = null;
    do {
      const res: QuidaxPage<T[]> = await this.get<T[]>(path, {
        ...opts,
        query: { per_page: 100, ...(opts.query ?? {}), page: page ?? undefined },
      });
      for (const item of res.data ?? []) yield item;
      page = res.nextPage;
    } while (page);
  }

  newReference(prefix: string): string {
    return `dvc_${prefix}_${ulid()}`;
  }

  // ── accounts ────────────────────────────────────────────────

  async fetchMainAccount(): Promise<QuidaxUser> {
    return (await this.get<QuidaxUser>('/users/me')).data;
  }

  async createSubAccount(input: {
    email: string;
    first_name: string;
    last_name: string;
  }): Promise<QuidaxUser> {
    // M9: sign-ups never queue in front of live trades.
    return this.post<QuidaxUser>('/users', input, { lane: 'background' });
  }

  async fetchSubAccount(userId: string): Promise<QuidaxUser> {
    return (await this.get<QuidaxUser>(`/users/${userId}`)).data;
  }

  // ── wallets & addresses ─────────────────────────────────────

  async fetchWallets(userId = 'me'): Promise<QuidaxWallet[]> {
    return (await this.get<QuidaxWallet[]>(`/users/${userId}/wallets`)).data;
  }

  /** The authoritative source for a coin's chain list — networks[]. */
  async fetchWallet(currency: string, userId = 'me'): Promise<QuidaxWallet> {
    return (await this.get<QuidaxWallet>(`/users/${userId}/wallets/${currency}`)).data;
  }

  /** Returns address:null — generation is async. Wait for wallet.address.generated. */
  async createPaymentAddress(
    userId: string,
    currency: string,
    network?: string,
  ): Promise<QuidaxPaymentAddress> {
    return this.post<QuidaxPaymentAddress>(
      `/users/${userId}/wallets/${currency}/addresses`,
      undefined,
      { lane: 'address', query: { network } },
    );
  }

  async fetchPaymentAddresses(userId: string, currency: string): Promise<QuidaxPaymentAddress[]> {
    return (
      await this.get<QuidaxPaymentAddress[]>(`/users/${userId}/wallets/${currency}/addresses`)
    ).data;
  }

  // ── pricing ─────────────────────────────────────────────────

  /** Non-binding. Consumes nothing. This is what a displayed rate comes from. */
  async temporaryQuotation(
    userId: string,
    input: { from_currency: string; to_currency: string; from_amount?: string; to_amount?: string },
    lane: Lane = 'default',
  ): Promise<QuidaxSwapQuotation> {
    // Non-binding and consumes nothing, so this one IS safe to retry — unlike
    // every other POST here, where a repeat could double-execute.
    const page = await this.call<QuidaxSwapQuotation>(
      'POST',
      `/users/${userId}/temporary_swap_quotation`,
      input,
      { lane, idempotent: true },
    );
    return page.data;
  }

  // ── swaps ───────────────────────────────────────────────────

  /** Binding. Expires in ~15 seconds — confirm immediately or re-quote. */
  async createSwapQuotation(
    userId: string,
    input: { from_currency: string; to_currency: string; from_amount?: string; to_amount?: string },
    lane: Lane = 'default',
  ): Promise<QuidaxSwapQuotation> {
    return this.post<QuidaxSwapQuotation>(`/users/${userId}/swap_quotation`, input, { lane });
  }

  /** Returns status:"initiated", not done. Completion arrives separately. */
  async confirmSwap(
    userId: string,
    quotationId: string,
    lane: Lane = 'default',
  ): Promise<QuidaxSwapTransaction> {
    return this.post<QuidaxSwapTransaction>(
      `/users/${userId}/swap_quotation/${quotationId}/confirm`,
      undefined,
      { lane, reference: quotationId },
    );
  }

  async fetchSwapTransactions(userId = 'me'): Promise<QuidaxSwapTransaction[]> {
    return (await this.get<QuidaxSwapTransaction[]>(`/users/${userId}/swap_transactions`)).data;
  }

  // ── NGN bank payouts ────────────────────────────────────────

  /**
   * Every bank, across every page. Quidax pages all list endpoints (50 by
   * default) and Nigeria has far more banks than that — one page would hide
   * most of them from the bank picker.
   */
  async fetchBanks(): Promise<QuidaxBank[]> {
    const banks: QuidaxBank[] = [];
    for await (const bank of this.paginate<QuidaxBank>('/banks')) banks.push(bank);
    return banks;
  }

  /** Read-only account-name resolution; the POST does not move money. */
  async verifyBankAccount(input: {
    accountNumber: string;
    bankCode: string;
  }): Promise<QuidaxVerifiedBankAccount> {
    const page = await this.call<QuidaxVerifiedBankAccount>(
      'POST',
      '/banks/verify_account',
      { fund_uid: input.accountNumber, fund_uid2: input.bankCode, currency: 'ngn' },
      { idempotent: true },
    );
    return page.data;
  }

  /** NGN bank payouts are sent from the merchant's main Quidax account. */
  async createNgnBankWithdrawal(
    input: {
      amount: string;
      accountNumber: string;
      bankCode: string;
      reference: string;
      transactionNote?: string;
      narration?: string;
    },
    userId = 'me',
  ): Promise<QuidaxWithdrawal> {
    return this.post<QuidaxWithdrawal>(
      `/users/${userId}/withdraws`,
      {
        currency: 'ngn',
        amount: input.amount,
        fund_uid: input.accountNumber,
        fund_uid2: input.bankCode,
        reference: input.reference,
        transaction_note: input.transactionNote,
        narration: input.narration,
      },
      { reference: input.reference },
    );
  }

  // ── transfers & withdrawals ─────────────────────────────────

  /**
   * Internal transfer. fund_uid is a Quidax user id, not an address.
   * Free, synchronous, returns status:"done". This is how every trade settles.
   */
  async internalTransfer(
    fromUserId: string,
    input: { currency: string; amount: string; fund_uid: string; reference: string },
    lane: Lane = 'default',
  ): Promise<QuidaxWithdrawal> {
    return this.post<QuidaxWithdrawal>(`/users/${fromUserId}/withdraws`, input, {
      lane,
      reference: input.reference,
    });
  }

  async createCryptoWithdrawal(
    userId: string,
    input: {
      currency: string;
      amount: string;
      fund_uid: string;
      fund_uid2?: string | null;
      network?: string;
      reference: string;
      transaction_note?: string;
      narration?: string;
    },
  ): Promise<QuidaxWithdrawal> {
    return this.post<QuidaxWithdrawal>(`/users/${userId}/withdraws`, input, {
      reference: input.reference,
    });
  }

  async fetchWithdrawals(
    userId = 'me',
    filters: { currency?: string; state?: 'processing' | 'done' | 'rejected' } = {},
  ): Promise<QuidaxWithdrawal[]> {
    return (await this.get<QuidaxWithdrawal[]>(`/users/${userId}/withdraws`, { query: filters }))
      .data;
  }

  /**
   * The withdrawal lives under whichever account SENT it. A sell transfers
   * sub -> main, so passing 'me' for those returns 404 and the leg never
   * resolves — which defeats the point of the reconciler.
   */
  async fetchWithdrawalByReference(
    reference: string,
    userId = 'me',
  ): Promise<QuidaxWithdrawal | null> {
    try {
      return (await this.get<QuidaxWithdrawal>(`/users/${userId}/withdraws/reference/${reference}`))
        .data;
    } catch (err) {
      if (err instanceof QuidaxError && err.httpStatus === 404) return null;
      throw err;
    }
  }

  // ── deposits ────────────────────────────────────────────────

  async fetchAllSubUserDeposits(filters: {
    currency?: string;
    state?: string;
    start_date?: string;
    end_date?: string;
  }): Promise<QuidaxDeposit[]> {
    // M9: every page. One page let the gap sweep miss deposits beyond it.
    const all: QuidaxDeposit[] = [];
    for await (const d of this.paginate<QuidaxDeposit>('/users/deposits/all', { query: filters })) all.push(d);
    return all;
  }

  async fetchDeposit(userId: string, depositId: string): Promise<QuidaxDeposit> {
    return (await this.get<QuidaxDeposit>(`/users/${userId}/deposits/${depositId}`)).data;
  }

  // ── fees ────────────────────────────────────────────────────

  async fetchWithdrawalFee(input: {
    currency: string;
    amount: string;
    network: string;
  }): Promise<QuidaxFeeRule> {
    return (await this.get<QuidaxFeeRule>('/users/me/fee_rule', { query: input })).data;
  }
}
