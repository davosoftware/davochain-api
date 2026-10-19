import type { Decimal } from '../common/money';

/**
 * The naira rail: the company that holds our naira, gives customers account
 * numbers, and pays naira out to Nigerian banks (Flutterwave today). Everything
 * new that touches naira goes through this one plug, so changing provider means
 * writing a new plug, not changing the screens or the money code (decision 19 Oct).
 */
export interface NairaRail {
  /** Shown on screens, e.g. "Flutterwave". */
  readonly name: string;
  /** Our naira at the rail. `available` can be spent now. */
  balance(): Promise<{ available: Decimal; ledger: Decimal }>;
  /** Nigerian banks the rail can pay. */
  banks(): Promise<Array<{ code: string; name: string }>>;
  /** The name on an account, as the bank gives it. */
  resolveAccount(input: { bankCode: string; accountNumber: string }): Promise<{ accountName: string }>;
  /**
   * Send naira to a bank account. Sent ONCE (never retried here). A clear "no"
   * throws RailRefusedError (nothing left; safe to refund); anything unclear
   * throws RailUnknownError (it may have gone; never refund, check by reference).
   */
  transfer(input: { reference: string; bankCode: string; accountNumber: string; amount: Decimal; narration: string }): Promise<RailTransfer>;
  /** Our transfer, found by our own reference. null = the rail has no record of it. */
  transferStatus(reference: string): Promise<RailTransfer | null>;
}

export interface RailTransfer {
  id: string;
  reference: string;
  status: 'PENDING' | 'SUCCESSFUL' | 'FAILED';
  fee: Decimal | null;
  /** Why it failed, in the rail's words. */
  reason: string | null;
}

/** Nest injection token for the active rail. */
export const NAIRA_RAIL = Symbol('NAIRA_RAIL');

/** The rail clearly said no: nothing was sent. */
export class RailRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RailRefusedError';
  }
}

/** We don't know whether it went (timeout, server error). Check by reference before doing anything. */
export class RailUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RailUnknownError';
  }
}
