/**
 * Quidax failures fall into three buckets, and conflating them loses money.
 *
 *   QuidaxError          — it failed, definitively. Safe to compensate.
 *   QuidaxRateLimitError — back off and retry. Nothing happened.
 *   QuidaxUnknownError   — WE DO NOT KNOW. Never retry blind, never refund.
 *                          Resolve by polling upstream. This is what puts a
 *                          transaction into RECONCILING.
 */

export class QuidaxError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly httpStatus: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'QuidaxError';
  }

  /** Quotation used or expired — re-quote, do not retry the same id. */
  get isExpiredQuotation(): boolean {
    return this.code === 'E0107' && /quotation/i.test(this.message);
  }

  get isInsufficientBalance(): boolean {
    return /insufficient|balance/i.test(this.message);
  }

  get isBelowMinimum(): boolean {
    return /minimum|too small|less than/i.test(this.message);
  }
}

export class QuidaxRateLimitError extends QuidaxError {
  constructor(httpStatus: number, retryAfterMs: number) {
    super(`Quidax rate limit (${httpStatus})`, null, httpStatus);
    this.name = 'QuidaxRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
  readonly retryAfterMs: number;
}

/**
 * A timeout on a confirm or a withdraw is NOT a failure. The request may well
 * have succeeded. Anything that throws this must leave funds locked and hand
 * the transaction to the reconciler.
 */
export class QuidaxUnknownError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly path: string,
    readonly reference?: string,
  ) {
    super(message);
    this.name = 'QuidaxUnknownError';
  }
}
