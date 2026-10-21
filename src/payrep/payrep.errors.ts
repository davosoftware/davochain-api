import { redactIds } from '../common/redact';

/**
 * CONFIG: our keys or setup were refused (ops must act).
 * REFUSED: Payrep clearly said no; nothing happened.
 * UNCLEAR: we don't know (timeout, 5xx, 80, 99, an odd answer). It may have happened.
 * TOKEN: the bearer token was refused; the client refreshes once.
 */
export type PayrepErrorKind = 'CONFIG' | 'REFUSED' | 'UNCLEAR' | 'TOKEN';

export class PayrepError extends Error {
  constructor(
    readonly kind: PayrepErrorKind,
    message: string,
    readonly httpStatus: number,
    readonly code: string | null,
  ) {
    super(redactIds(message));
    this.name = 'PayrepError';
  }
}
