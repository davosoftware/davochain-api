import { DojahError } from './dojah.errors';
import type { DojahOp } from './dojah.types';

/** Codes that mean the request never reached Dojah, so it cannot have been performed. */
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

function errorText(body: unknown): string {
  if (body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string') {
    return (body as { error: string }).error.slice(0, 200);
  }
  return '';
}

/**
 * Plan §R1.2 for an answered request. Any non-2xx answer except a lookup's 404
 * is DEFINITELY_FAILED: Dojah answered and refused, and is assumed not to bill it.
 */
export function classifyHttp(
  status: number,
  body: unknown,
  op: DojahOp,
): { ok: true; body: unknown } | { ok: true; notFound: true } | { ok: false; error: DojahError } {
  if (status >= 200 && status < 300) {
    if (body === undefined || body === null || typeof body !== 'object') {
      return { ok: false, error: new DojahError('UNKNOWN', `Dojah ${op} answered ${status} with no readable body`, status) };
    }
    return { ok: true, body };
  }
  if (status === 404 && op === 'lookup') return { ok: true, notFound: true };

  const said = errorText(body);
  const msg = (what: string) => `Dojah ${op}: ${what} (HTTP ${status}${said ? `: ${said}` : ''})`;
  if (status === 401) return { ok: false, error: new DojahError('AUTH', msg('the app ID or secret key was refused'), status) };
  if (status === 402) return { ok: false, error: new DojahError('WALLET', msg('the wallet is empty'), status) };
  if (status === 403) {
    // Name the problem, never the IP address itself (spec §6).
    return { ok: false, error: new DojahError('IP', `Dojah ${op}: this server's IP is not whitelisted on the Dojah app (HTTP 403)`, status) };
  }
  if (status === 424) return { ok: false, error: new DojahError('UNPROCESSABLE', msg('the document could not be processed'), status) };
  if (status === 429) return { ok: false, error: new DojahError('RATE_LIMITED', msg('rate limited'), status) };
  if (status >= 500) return { ok: false, error: new DojahError('SERVER', msg('server error'), status) };
  return { ok: false, error: new DojahError('BAD_REQUEST', msg('the request was refused'), status) };
}

/** Plan §R1.2 for a request with no answer. When in doubt, UNKNOWN: assume it was billed. */
export function classifyTransportError(err: unknown): DojahError {
  const chain: unknown[] = [];
  for (let e: unknown = err, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i++) chain.push(e);
  for (const e of chain) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && NOT_SENT.has(code)) {
      return new DojahError('NOT_SENT', `Dojah could not be reached (${code})`, 0);
    }
  }
  const first = chain[0] as { name?: string; code?: string } | undefined;
  const label = first?.code ?? first?.name ?? 'error';
  return new DojahError('UNKNOWN', `Dojah did not answer in time or the connection broke (${label})`, 0);
}
