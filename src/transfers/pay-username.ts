/**
 * Payment usernames (decisions 28 Oct 2026): the name other customers type to
 * send crypto. Separate from the referral username (referral-code.ts).
 */
export const PAY_USERNAME_MIN = 7;
export const PAY_USERNAME_MAX = 20;

/**
 * Parts nobody may use anywhere in a payment username: a send to "@davochain_help"
 * would be read as a send to us.
 */
const OFFICIAL = ['davochain', 'davo', 'admin', 'support', 'official', 'staff', 'helpdesk', 'quidax', 'payrep', 'dojah', 'system', 'security'];

export interface PayUsernameVerdict {
  ok: boolean;
  /** Lower case, without a leading @. */
  value: string;
  reason?: string;
}

/** Whether somebody may have this payment username, and if not, a reason they can act on. */
export function checkPayUsername(input: string): PayUsernameVerdict {
  const value = (input ?? '').trim().replace(/^@/, '').toLowerCase();
  const no = (reason: string): PayUsernameVerdict => ({ ok: false, value, reason });

  if (!value) return no('Choose a username first.');
  if (/\s/.test(value)) return no('A username can have no spaces. Use _ or - instead.');
  if (!/^[a-z0-9_-]+$/.test(value)) return no('A username can only use letters, numbers, _ and -.');
  if (value.length < PAY_USERNAME_MIN) return no(`A username needs at least ${PAY_USERNAME_MIN} characters.`);
  if (value.length > PAY_USERNAME_MAX) return no(`A username can be at most ${PAY_USERNAME_MAX} characters.`);
  if (!/[a-z]/.test(value)) return no('A username needs at least one letter.');
  if (!/^[a-z0-9].*[a-z0-9]$/.test(value)) return no('A username must start and end with a letter or number.');
  if (OFFICIAL.some((word) => value.includes(word))) return no('That username looks official. Please choose another.');
  return { ok: true, value };
}

/** "Ada O.": enough for a sender to recognise the person, not their full name. */
export function displayName(u: { firstName: string; lastName: string }): string {
  const initial = u.lastName.trim().slice(0, 1).toUpperCase();
  return initial ? `${u.firstName.trim()} ${initial}.` : u.firstName.trim();
}
