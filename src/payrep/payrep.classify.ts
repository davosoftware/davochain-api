/**
 * Payrep's answers, in the only terms the money code acts on (spec §2.1, §2.2).
 * The decision follows the envelope {status, response_code, message, data},
 * never the HTTP status alone. Code 80 means several things (service down,
 * duplicate reference, not found) and is never a refusal.
 */
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const envelope = (body: unknown) => {
  const b = obj(body);
  return { b, status: b?.status, code: text(b?.response_code), message: text(b?.message), data: b?.data };
};
const isOk = (httpStatus: number) => httpStatus >= 200 && httpStatus < 300;

export type TransferAnswer =
  | { kind: 'SENT'; id: string; providerStatus: 'successful' | 'pending' | 'failed'; fee: string | null }
  | { kind: 'QUEUED_FOR_APPROVAL' }
  | { kind: 'REFUSED'; reason: string }
  | { kind: 'UNCLEAR'; reason: string };

/** Funds transfer. Refused only on 51 or HTTP 400 "invalid"; everything not clearly sent is UNCLEAR. */
export function classifyTransfer(httpStatus: number, body: unknown): TransferAnswer {
  const e = envelope(body);
  if (!e.b) return { kind: 'UNCLEAR', reason: `HTTP ${httpStatus} with no readable answer` };
  if (httpStatus === 400 && e.code === 'invalid') return { kind: 'REFUSED', reason: e.message || 'The transfer details were refused' };
  const data = obj(e.data);
  // Maker-checker (spec §2.5 C2): Payrep says yes, but nothing has been sent.
  if (e.status === true && (data?.auth_request_id || /once it has been approved/i.test(e.message))) return { kind: 'QUEUED_FOR_APPROVAL' };
  if (e.status === false && e.code === '51') return { kind: 'REFUSED', reason: e.message || 'Insufficient balance' };
  if (isOk(httpStatus) && e.status === true && e.code === '00' && data) {
    const s = text(data.status).toLowerCase();
    const id = text(data.id);
    if (id && (s === 'successful' || s === 'pending' || s === 'failed')) {
      const fee = text(data.charges);
      return { kind: 'SENT', id, providerStatus: s, fee: fee || null };
    }
  }
  return { kind: 'UNCLEAR', reason: `HTTP ${httpStatus}, code ${e.code || 'none'}: ${e.message || 'no message'}` };
}

export type StatusAnswer =
  | { kind: 'FOUND'; status: 'SUCCESSFUL' | 'PENDING' | 'FAILED' }
  | { kind: 'NOT_FOUND' }
  | { kind: 'UNCLEAR'; reason: string };

/** Transaction Status. NOT_FOUND only on the exact "Transaction not found." answer. */
export function classifyStatus(httpStatus: number, body: unknown): StatusAnswer {
  const e = envelope(body);
  if (!e.b) return { kind: 'UNCLEAR', reason: `HTTP ${httpStatus} with no readable answer` };
  if (e.status === false && e.code === '80' && /^Transaction not found\.?$/.test(e.message)) return { kind: 'NOT_FOUND' };
  const data = obj(e.data);
  if (isOk(httpStatus) && e.status === true && e.code === '00' && data) {
    const s = text(data.transaction_status).toLowerCase();
    if (s === 'successful') return { kind: 'FOUND', status: 'SUCCESSFUL' };
    if (s === 'failed') return { kind: 'FOUND', status: 'FAILED' };
    if (s === 'pending' || s === 'processing') return { kind: 'FOUND', status: 'PENDING' };
  }
  return { kind: 'UNCLEAR', reason: `HTTP ${httpStatus}, code ${e.code || 'none'}: ${e.message || 'no message'}` };
}

export type FailKind = 'CONFIG' | 'REFUSED' | 'UNCLEAR' | 'TOKEN';
export type ReadAnswer<T = unknown> = { ok: true; data: T } | { ok: false; kind: FailKind; code: string | null; message: string };

const unclearHttp = (h: number) => h === 429 || h >= 500 || h === 0;
const failWith = (e: ReturnType<typeof envelope>, httpStatus: number) => (kind: FailKind) => ({
  ok: false as const,
  kind,
  code: e.code || null,
  message: e.message || `HTTP ${httpStatus}`,
});

/** Reads (banks, name enquiry, balance, transactions). Code 42 means "token" only when the message says so. */
export function classifyRead<T = unknown>(httpStatus: number, body: unknown): ReadAnswer<T> {
  const e = envelope(body);
  const fail = failWith(e, httpStatus);
  if (httpStatus === 401) return fail('TOKEN');
  if (!e.b || unclearHttp(httpStatus)) return fail('UNCLEAR');
  if (isOk(httpStatus) && e.status === true && e.code === '00') return { ok: true, data: e.data as T };
  if (e.code === '42' && /token/i.test(e.message)) return fail('TOKEN');
  if (e.code === '41' || e.code === '43' || httpStatus === 403) return fail('CONFIG');
  if (['01', '02', '06', '42', 'invalid'].includes(e.code) || httpStatus === 400 || httpStatus === 404) return fail('REFUSED');
  return fail('UNCLEAR');
}

/** Opening a customer account is a write: anything not clearly a no may have opened it. */
export function classifyCreateAccount<T = unknown>(httpStatus: number, body: unknown): ReadAnswer<T> {
  const e = envelope(body);
  const fail = failWith(e, httpStatus);
  if (httpStatus === 401) return fail('TOKEN');
  if (!e.b || unclearHttp(httpStatus)) return fail('UNCLEAR');
  if (isOk(httpStatus) && e.status === true && e.code === '00' && obj(e.data)) return { ok: true, data: e.data as T };
  if (e.code === '42' && /token/i.test(e.message)) return fail('TOKEN');
  // 42 here is "pool account not found": our setup, not the customer's.
  if (e.code === '41' || e.code === '43' || e.code === '42') return fail('CONFIG');
  if (['83', '01', '02'].includes(e.code) || (httpStatus === 400 && e.code === 'invalid')) return fail('REFUSED');
  return fail('UNCLEAR');
}
