import { Logger } from '@nestjs/common';
import { request } from 'undici';
import { parseJsonExact } from '../common/exact-json';
import { DEADLINES, DojahConfig } from './dojah.config';
import { classifyHttp, classifyTransportError } from './dojah.classify';
import { DojahError } from './dojah.errors';
import { normaliseIdentity, parseAmlResult } from './normalise';
import type { AmlResult, DojahOp, LookupResult } from './dojah.types';

export interface AmlInput {
  names: string;
  date_of_birth?: string;
  gender?: 'Male' | 'Female';
  nationality: 'NG';
}

/** The seam the services depend on. The real client or the mock is bound to it by DojahModule. */
export abstract class DojahApi {
  abstract lookup(idType: 'BVN' | 'NIN', idNumber: string): Promise<LookupResult>;
  abstract screen(input: AmlInput, reference: string): Promise<AmlResult>;
  abstract balance(): Promise<number>;
}

const BACKOFF_MS = [250, 1000];

/**
 * The only code that calls Dojah. Retries follow plan §R1.3 exactly:
 * - balance (free): retried on anything but a definite refusal of our credentials;
 * - lookup (paid): retried ONLY if never sent, or on 429;
 * - AML (paid): never retried here. Later retries belong to the recovery cron.
 * Never logs a body, a number or a key. Built by DojahModule's factory, not by DI.
 */
export class DojahClient extends DojahApi {
  private readonly log = new Logger(DojahClient.name);

  constructor(
    private readonly cfg: Pick<DojahConfig, 'baseUrl' | 'credentials'>,
    private readonly deadlines: { lookup: number; aml: number; balance: number } = DEADLINES,
  ) {
    super();
  }

  async lookup(idType: 'BVN' | 'NIN', idNumber: string): Promise<LookupResult> {
    const path =
      idType === 'BVN'
        ? `/api/v1/kyc/bvn/full?bvn=${encodeURIComponent(idNumber)}`
        : `/api/v1/kyc/nin?nin=${encodeURIComponent(idNumber)}`;
    const shown = idType === 'BVN' ? '/api/v1/kyc/bvn/full' : '/api/v1/kyc/nin';
    const retryable = (e: DojahError) => e.kind === 'NOT_SENT' || e.kind === 'RATE_LIMITED';
    const r = await this.call('lookup', 'GET', path, shown, undefined, retryable);
    if ('notFound' in r) return { found: false, httpStatus: 404 };
    return { found: true, identity: normaliseIdentity(r.body), httpStatus: r.status };
  }

  async screen(input: AmlInput, reference: string): Promise<AmlResult> {
    const body = {
      schema: 'individual',
      unique_reference: reference,
      properties: input,
      screening_options: { pep_check: true, sanction: true, adverse_media_check: true },
    };
    const r = await this.call('aml', 'POST', '/api/v1/aml/v2/screening', '/api/v1/aml/v2/screening', body, () => false);
    if ('notFound' in r) throw new DojahError('BAD_REQUEST', 'Dojah AML answered 404', 404);
    return { parsed: parseAmlResult(r.body), httpStatus: r.status };
  }

  async balance(): Promise<number> {
    const retryable = (e: DojahError) => !['AUTH', 'IP', 'BAD_REQUEST', 'CONFIG'].includes(e.kind);
    const r = await this.call('balance', 'GET', '/api/v1/balance', '/api/v1/balance', undefined, retryable);
    if ('notFound' in r) throw new DojahError('BAD_REQUEST', 'Dojah balance answered 404', 404);
    const raw = (r.body as { entity?: { wallet_balance?: unknown } }).entity?.wallet_balance;
    const n = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : Number.NaN;
    if (!Number.isFinite(n)) throw new DojahError('UNKNOWN', 'Dojah balance was not a number', r.status);
    return n;
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async call(
    op: DojahOp,
    method: 'GET' | 'POST',
    path: string,
    shown: string,
    body: unknown,
    retryable: (e: DojahError) => boolean,
  ): Promise<{ body: unknown; status: number } | { notFound: true }> {
    const { appId, secretKey } = await this.cfg.credentials();
    const deadline = this.deadlines[op];
    let last: DojahError | null = null;

    for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
      if (attempt > 0) await this.sleep(BACKOFF_MS[attempt - 1]);
      const started = Date.now();
      try {
        const res = await request(this.cfg.baseUrl + path, {
          method,
          headers: { AppId: appId, Authorization: secretKey, accept: 'application/json', 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          headersTimeout: deadline,
          bodyTimeout: deadline,
          // undici checks its own timeouts on a coarse tick; this is the exact deadline.
          signal: AbortSignal.timeout(deadline),
        });
        const text = await res.body.text();
        let parsed: unknown;
        try {
          parsed = text ? parseJsonExact(text) : undefined;
        } catch {
          parsed = undefined;
        }
        const verdict = classifyHttp(res.statusCode, parsed, op);
        this.log.log(`${method} ${shown} → ${res.statusCode} in ${Date.now() - started}ms`);
        if (verdict.ok) return 'notFound' in verdict ? { notFound: true } : { body: verdict.body, status: res.statusCode };
        last = verdict.error;
      } catch (err) {
        last = classifyTransportError(err);
        this.log.warn(`${method} ${shown} → no answer in ${Date.now() - started}ms (${last.kind})`);
      }
      if (!retryable(last)) break;
    }
    throw last ?? new DojahError('UNKNOWN', `Dojah ${op} failed`, 0);
  }
}
