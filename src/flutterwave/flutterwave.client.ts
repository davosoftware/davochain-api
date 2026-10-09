import { Injectable, Logger } from '@nestjs/common';
import { request } from 'undici';
import { parseJsonExact } from '../common/exact-json';
import { TokenBucket } from '../quidax/rate-limiter';
import { FlutterwaveConfig } from './flutterwave.config';
import { classifyResponse } from './flutterwave.classify';
import { FlutterwaveError, FlutterwaveUnknownError, redactIds } from './flutterwave.errors';
import type {
  CreateStaticAccountInput,
  FlwBalance,
  FlwEnvelope,
  FlwStaticAccount,
  FlwTransaction,
  ListTransactionsQuery,
} from './flutterwave.types';

export interface FlutterwaveClientOptions {
  /** Waits before each read retry. Tests pass zeros. */
  backoffMs?: number[];
  /** Per-request timeout: longer than Flutterwave's own 28 s, so its 503 arrives first. */
  timeoutMs?: number;
  /** Deadline for a probe: one quick look that must not hold a caller up. */
  probeTimeoutMs?: number;
}

export interface ReadOptions {
  /** One attempt, a short deadline, no retries: for checks a person is waiting on. */
  probe?: boolean;
}

const DEFAULT_BACKOFF_MS = [1_000, 2_000, 4_000];
const DEFAULT_TIMEOUT_MS = 35_000;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const NUMERIC_ID = /^\d{1,19}$/;
const ORDER_REF = /^[A-Za-z0-9_-]{1,64}$/;

interface CallOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Writes are sent once. Only reads are retried. */
  write: boolean;
  probe?: boolean;
}

/**
 * The only thing in the codebase that talks to Flutterwave.
 *
 * Every answer is classified (flutterwave.classify.ts). Reads are retried on
 * UNKNOWN and RATE_LIMITED; writes never are — an unknown write is resolved by
 * whoever made it, by looking. Every number in a response arrives as exact
 * text, so money never passes through a float. Request bodies are never
 * logged: one of them carries a BVN.
 */
@Injectable()
export class FlutterwaveClient {
  protected readonly log = new Logger('FlutterwaveClient');
  private readonly bucket: TokenBucket;
  private readonly backoffMs: number[];
  private readonly timeoutMs: number;
  private readonly probeTimeoutMs: number;

  constructor(
    protected readonly cfg: FlutterwaveConfig,
    options: FlutterwaveClientOptions = {},
  ) {
    this.bucket = TokenBucket.perMinute(cfg.rateLimitPerMinute, 'flutterwave');
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  }

  // ── virtual accounts ──────────────────────────────────────

  async createStaticVirtualAccount(input: CreateStaticAccountInput): Promise<FlwStaticAccount> {
    if (!input.bvn === !input.nin) throw new Error('Exactly one of bvn or nin is required');
    const body = {
      email: input.email,
      is_permanent: true,
      tx_ref: input.txRef,
      firstname: input.firstName,
      lastname: input.lastName,
      narration: input.narration,
      currency: 'NGN',
      bank_code: '090567',
      ...(input.bvn ? { bvn: input.bvn } : { nin: input.nin }),
    };
    const path = '/virtual-account-numbers';
    return this.requireData(await this.call<FlwStaticAccount>('POST', path, { body, write: true }), 'POST', path);
  }

  async getVirtualAccount(orderRef: string): Promise<FlwStaticAccount> {
    const path = `/virtual-account-numbers/${this.safeOrderRef(orderRef)}`;
    return this.requireData(await this.call<FlwStaticAccount>('GET', path, { write: false }), 'GET', path);
  }

  async setVirtualAccountStatus(orderRef: string, status: 'active' | 'inactive'): Promise<void> {
    const path = `/virtual-account-numbers/${this.safeOrderRef(orderRef)}`;
    await this.call('POST', path, { body: { status }, write: true });
  }

  // ── transactions ──────────────────────────────────────────

  async verifyTransaction(id: string): Promise<FlwTransaction> {
    const path = `/transactions/${this.safeId(id)}/verify`;
    return this.requireData(await this.call<FlwTransaction>('GET', path, { write: false }), 'GET', path);
  }

  async listTransactions(q: ListTransactionsQuery): Promise<{ items: FlwTransaction[]; totalPages: number }> {
    const res = await this.call<FlwTransaction[]>('GET', '/transactions', {
      write: false,
      query: { from: q.from, to: q.to, page: q.page, status: q.status, currency: q.currency },
    });
    const items = Array.isArray(res.data) ? res.data : [];
    const totalPages = Number(res.meta?.page_info?.total_pages ?? 0);
    return { items, totalPages: Number.isFinite(totalPages) ? totalPages : 0 };
  }

  // ── balances ──────────────────────────────────────────────

  async getBalance(currency: string, read: ReadOptions = {}): Promise<FlwBalance> {
    const path = `/balances/${encodeURIComponent(currency.toUpperCase())}`;
    return this.requireData(await this.call<FlwBalance>('GET', path, { write: false, probe: read.probe }), 'GET', path);
  }

  // ── transport ─────────────────────────────────────────────

  protected async call<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    opts: CallOptions,
  ): Promise<FlwEnvelope<T>> {
    const key = await this.cfg.secretKey(); // a CONFIG error when missing or in the wrong mode
    const url = new URL(this.cfg.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
    const attempts = opts.write || opts.probe ? 1 : this.backoffMs.length + 1;
    const timeoutMs = opts.probe ? Math.min(this.probeTimeoutMs, this.timeoutMs) : this.timeoutMs;
    let last: FlutterwaveError | FlutterwaveUnknownError | null = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      await this.bucket.take();
      const started = Date.now();
      let httpStatus = 0;
      let parsed: unknown;
      try {
        const res = await request(url.toString(), {
          method,
          headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
          // undici checks its own timeouts on a coarse tick; this is the exact deadline.
          signal: AbortSignal.timeout(timeoutMs),
        });
        httpStatus = res.statusCode;
        const text = await res.body.text();
        try {
          parsed = text ? parseJsonExact(text) : undefined;
        } catch {
          parsed = undefined;
        }
      } catch (err) {
        httpStatus = 0;
        last = new FlutterwaveUnknownError(
          `Flutterwave ${method} ${path} did not answer: ${redactIds((err as Error).message)}`,
          method,
          path,
        );
      }

      const ms = Date.now() - started;
      if (httpStatus !== 0) {
        const verdict = classifyResponse(httpStatus, parsed, method, path);
        if (!verdict) {
          this.log.log(`${method} ${path} → ${httpStatus} in ${ms}ms`);
          return parsed as FlwEnvelope<T>;
        }
        const label = verdict instanceof FlutterwaveError ? verdict.kind : 'UNKNOWN';
        this.log.warn(`${method} ${path} → ${httpStatus} ${label}: ${verdict.message} (${ms}ms)`);
        last = verdict;
      } else {
        this.log.warn(`${method} ${path} → no answer in ${ms}ms: ${last?.message ?? ''}`);
      }

      const retryable =
        last instanceof FlutterwaveUnknownError ||
        (last instanceof FlutterwaveError && last.kind === 'RATE_LIMITED');
      if (!retryable || attempt === attempts) break;
      const wait = this.backoffMs[attempt - 1] ?? 0;
      await this.sleep(wait > 0 ? wait + Math.floor(Math.random() * 250) : 0);
    }
    throw last ?? new FlutterwaveUnknownError(`Flutterwave ${method} ${path} failed`, method, path);
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private requireData<T>(res: FlwEnvelope<T>, method: string, path: string): T {
    if (res.data === undefined || res.data === null) {
      throw new FlutterwaveUnknownError(`Flutterwave ${method} ${path} said success but sent no data`, method, path);
    }
    return res.data;
  }

  private safeId(id: string): string {
    if (!NUMERIC_ID.test(id)) throw new FlutterwaveError('DEFINITE', 'Not a Flutterwave transaction id', 0);
    return id;
  }

  private safeOrderRef(ref: string): string {
    if (!ORDER_REF.test(ref)) throw new FlutterwaveError('DEFINITE', 'Not a Flutterwave order reference', 0);
    return ref;
  }
}
