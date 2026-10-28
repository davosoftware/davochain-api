import { randomInt } from 'node:crypto';

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

/** Digits for a generated name, from a secure source so they cannot be predicted. */
const randomDigits = (n: number): string => Array.from({ length: n }, () => String(randomInt(10))).join('');

/**
 * The name every customer gets at sign-up (decision 28 Oct 2026):
 * "firstname_" and random digits, lower case, 7 to 20 characters. Accents are
 * folded and anything else dropped; a first name with no letters left, or one
 * that looks official, becomes "user". The customer can change it later.
 */
export function generatePayUsername(firstName: string, digits: (n: number) => string = randomDigits, minDigits = 4): string {
  let base = (firstName ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '') // accent marks, after NFKD split them off
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (!/[a-z]/.test(base) || OFFICIAL.some((word) => base.includes(word))) base = 'user';
  const count = Math.max(minDigits, PAY_USERNAME_MIN - Math.min(base.length, PAY_USERNAME_MAX) - 1);
  base = base.slice(0, PAY_USERNAME_MAX - 1 - count);
  return `${base}_${digits(count)}`;
}
