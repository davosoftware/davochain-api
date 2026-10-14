import { redactIds } from '../flutterwave/flutterwave.errors';

/**
 * Why a Dojah call failed, in the terms the rest of the code acts on.
 * CONFIG/AUTH/IP/WALLET/BAD_REQUEST/RATE_LIMITED/SERVER/NOT_SENT are DEFINITELY_FAILED
 * (Dojah answered and refused, or never received it). UNKNOWN means it may
 * have been performed and billed (plan §R1.2).
 */
export type DojahFailureKind =
  | 'CONFIG'
  | 'AUTH'
  | 'IP'
  | 'WALLET'
  | 'BAD_REQUEST'
  | 'RATE_LIMITED'
  | 'SERVER'
  | 'NOT_SENT'
  | 'UNKNOWN';

export class DojahError extends Error {
  constructor(
    readonly kind: DojahFailureKind,
    message: string,
    readonly httpStatus: number,
  ) {
    super(redactIds(message));
    this.name = 'DojahError';
  }

  /** Dojah certainly did not perform the call (plan §R1.2). */
  get definitelyFailed(): boolean {
    return this.kind !== 'UNKNOWN';
  }
}
