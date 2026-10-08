/**
 * The tx_ref every virtual account of a user carries: dcva_<user id, no dashes>.
 *
 * Flutterwave returns it on each deposit into the account, so a payment routes
 * to its owner by our own reference, never by anything a sender typed. It is the
 * same on every account the user has, so an account we never heard about (a
 * creation that timed out) still routes correctly.
 */
export const TX_REF_PREFIX = 'dcva_';
const TX_REF = /^dcva_([0-9a-f]{32})$/;

export function txRefForUser(userId: string): string {
  return TX_REF_PREFIX + userId.replace(/-/g, '').toLowerCase();
}

export function userIdFromTxRef(txRef: string | null | undefined): string | null {
  const match = typeof txRef === 'string' ? TX_REF.exec(txRef) : null;
  if (!match) return null;
  const h = match[1];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function isOurTxRef(txRef: string | null | undefined): boolean {
  return typeof txRef === 'string' && TX_REF.test(txRef);
}

/** Looser than isOurTxRef: anything we may have issued, including a malformed one worth flagging. */
export function hasOurPrefix(txRef: string | null | undefined): boolean {
  return typeof txRef === 'string' && txRef.startsWith(TX_REF_PREFIX);
}
