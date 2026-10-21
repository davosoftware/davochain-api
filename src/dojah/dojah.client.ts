import { Logger } from '@nestjs/common';
import { request } from 'undici';
import { parseJsonExact } from '../common/exact-json';
import { DEADLINES, DojahConfig } from './dojah.config';
import { classifyHttp, classifyTransportError } from './dojah.classify';
import { DojahError } from './dojah.errors';
import { normaliseIdentity, parseAmlResult } from './normalise';
import { parseBill, parseIdAnalysis, parseLiveness, parseMatch, parseOcr } from './advanced-parse';
import type { AmlResult, DojahOp, LookupResult } from './dojah.types';
import type { AdvancedIdTypeName, BillRead, IdRead, LivenessRead, MatchRead } from '../kyc/advanced/advanced.types';

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
  /** Advanced (spec 2026-10-21 §3). Every image is base64 with no "data:" prefix. */
  abstract readId(i: { idType: AdvancedIdTypeName; front: string; back?: string }): Promise<{ read: IdRead; portrait: string | null; httpStatus: number }>;
  abstract liveness(selfie: string): Promise<{ read: LivenessRead; httpStatus: number }>;
  abstract faceMatch(selfie: string, idPhoto: string): Promise<{ read: MatchRead; httpStatus: number }>;
  abstract utilityBill(url: string): Promise<{ read: BillRead; httpStatus: number }>;
  abstract ocr(image: string): Promise<{ lines: string[]; httpStatus: number }>;
}

const DOJAH_DOCUMENT_TYPE: Record<AdvancedIdTypeName, string> = { NATIONAL_ID: 'NATIONAL_ID', PASSPORT: 'PASSPORT', DRIVERS_LICENSE: 'DRIVING_LICENSE' };
/** Paid, like lookup: retried only if never sent or on 429 (plan §R1.3). */
const paidRetry = (e: DojahError) => e.kind === 'NOT_SENT' || e.kind === 'RATE_LIMITED';

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
    private readonly deadlines: Partial<Record<DojahOp, number>> = DEADLINES,
    /** For scripts/check-dojah-advanced.ts only: sees each 2xx answer. The app never sets it. */
    private readonly onRaw?: (op: DojahOp, body: unknown) => void,
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

  async readId(i: { idType: AdvancedIdTypeName; front: string; back?: string }) {
    const body = { input_type: 'base64', imagefrontside: i.front, ...(i.back ? { imagebackside: i.back } : {}), document_type: DOJAH_DOCUMENT_TYPE[i.idType] };
    const r = await this.post('readId', '/api/v1/document/analysis', body);
    return { ...parseIdAnalysis(r.body), httpStatus: r.status };
  }

  async liveness(selfie: string) {
    const r = await this.post('liveness', '/api/v1/ml/liveness', { image: selfie });
    return { read: parseLiveness(r.body), httpStatus: r.status };
  }

  async faceMatch(selfie: string, idPhoto: string) {
    const r = await this.post('faceMatch', '/api/v1/kyc/photoid/verify', { selfie_image: selfie, photoid_image: idPhoto });
    return { read: parseMatch(r.body), httpStatus: r.status };
  }

  async utilityBill(url: string) {
    const r = await this.post('utilityBill', '/api/v1/document/analysis/utility_bill', { input_type: 'url', input_value: url });
    return { read: parseBill(r.body), httpStatus: r.status };
  }

  async ocr(image: string) {
    const r = await this.post('ocr', '/api/v1/ml/ocr/generic', { img: image });
    return { lines: parseOcr(r.body), httpStatus: r.status };
  }

  /** These bodies hold faces and documents: call() never logs a body. */
  private async post(op: DojahOp, path: string, body: unknown): Promise<{ body: unknown; status: number }> {
    const r = await this.call(op, 'POST', path, path, body, paidRetry);
    if ('notFound' in r) throw new DojahError('BAD_REQUEST', `Dojah ${op} answered 404`, 404);
    return r;
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
    const deadline = this.deadlines[op] ?? DEADLINES[op];
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
        if (verdict.ok && !('notFound' in verdict)) this.onRaw?.(op, verdict.body);
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
