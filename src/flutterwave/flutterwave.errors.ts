export type FlwFailureKind = 'DEFINITE' | 'CONFIG' | 'NOT_FOUND' | 'ALREADY_EXISTS' | 'RATE_LIMITED';

/**
 * Flutterwave answered, and the answer is a definite "no" of some kind.
 *
 * DEFINITE / NOT_FOUND / ALREADY_EXISTS: this call created or changed nothing.
 * CONFIG: our key, IP whitelist or dashboard settings are wrong.
 * RATE_LIMITED: nothing happened; try later.
 */
export class FlutterwaveError extends Error {
  constructor(
    readonly kind: FlwFailureKind,
    message: string,
    readonly httpStatus: number,
    /** Flutterwave often puts the useful part in `data` as a string. Redacted. */
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = 'FlutterwaveError';
  }
}

/**
 * We do not know what happened: a timeout, a 5xx (including Flutterwave's own
 * 28-second 503), a body that isn't JSON. Never treat this as a failure — the
 * call may have worked. Find out by looking, never by repeating a write.
 */
export class FlutterwaveUnknownError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'FlutterwaveUnknownError';
  }
}

/**
 * BVNs, NINs and phone numbers are 11 digits; none of them belong in a log, an
 * exception or a stored error. Transaction ids (8–10 digits), account numbers
 * (10) and bank session ids (25+) are left readable.
 */
export function redactIds(text: string): string {
  return text.replace(/(?<!\d)\d{11}(?!\d)/g, '[REDACTED]');
}
