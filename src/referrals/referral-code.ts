import { randomInt } from 'node:crypto';

/**
 * The characters a code may contain.
 *
 * No 0, O, 1, I or L. A referral code gets read off a screen, typed into a
 * phone and said out loud, and every one of those pairs is a wrong signup
 * waiting to happen — the referrer never gets paid and neither of them can
 * work out why.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Total length of a generated code. Same ceiling as a chosen username. */
export const CODE_LENGTH = 7;

/** How much of a generated code comes from the person's name. */
const NAME_CHARS = 3;

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 7;

/**
 * Codes nobody may claim as a username.
 *
 * Two reasons. A username becomes a public link — davochain.com/r/SUPPORT
 * would be read as ours, not as a person's. And these words appear in our own
 * URLs, so one of them as a code invites a routing collision later.
 */
const RESERVED = new Set([
  'ADMIN',
  'API',
  'APP',
  'AUTH',
  'DAVO',
  'DAVOPAY',
  'DVC',
  'HELP',
  'INFO',
  'LOGIN',
  'NULL',
  'ROOT',
  'SIGNUP',
  'STAFF',
  'SUPPORT',
  'SYSTEM',
  'TEAM',
  'TEST',
  'UNDEFINED',
  'WALLET',
  'WWW',
]);

/**
 * Letters from a name, upper-cased, at most NAME_CHARS of them.
 *
 * Accents are folded rather than dropped, so Chiamaka and Chiamaká start the
 * same way. A name with no usable letters at all — initials, an emoji, a
 * script we cannot fold — falls back to DVC rather than producing a short
 * code, because the length is what carries the randomness.
 */
function stem(name: string): string {
  const letters = name
    .normalize('NFD')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  return letters.slice(0, NAME_CHARS) || 'DVC';
}

/**
 * A referral code for somebody, from their name plus randomness.
 *
 * Recognisably theirs — ADA4K7X reads as Ada's — but not guessable: the tail
 * is drawn from a 31-character alphabet, so knowing somebody's first name
 * leaves ~900,000 possibilities. Guessing one would attribute a signup to a
 * stranger, which is somebody else's money.
 *
 * Collisions are possible and expected. The caller retries; the unique index
 * on the column is what actually guarantees it.
 */
export function generateReferralCode(
  firstName: string,
  // Injectable so a test can pin the tail without stubbing the crypto module.
  pick: (max: number) => number = (max) => randomInt(max),
): string {
  const head = stem(firstName);
  const tail = Array.from(
    { length: CODE_LENGTH - head.length },
    () => ALPHABET[pick(ALPHABET.length)],
  ).join('');
  return head + tail;
}

/** Whatever was typed, in the one form a code is stored and compared in. */
export function normaliseCode(input: string): string {
  return input.trim().toUpperCase();
}

export interface UsernameVerdict {
  ok: boolean;
  /** What to tell the person, in their own terms. Null when it is fine. */
  reason: string | null;
  /** The form it would be stored in. */
  value: string;
}

/**
 * Whether somebody may have this username, and if not, why.
 *
 * The reason is the point. "Invalid username" tells a person nothing they can
 * act on, and a rule they cannot see is a rule they will keep breaking.
 */
export function checkUsername(input: string): UsernameVerdict {
  const value = normaliseCode(input ?? '');
  const no = (reason: string): UsernameVerdict => ({ ok: false, reason, value });

  if (!value) return no('Choose a username first.');
  if (value.length < USERNAME_MIN) {
    return no(`A username needs at least ${USERNAME_MIN} characters.`);
  }
  if (value.length > USERNAME_MAX) {
    return no(`A username can be at most ${USERNAME_MAX} characters.`);
  }
  if (!/^[A-Z0-9]+$/.test(value)) {
    return no('Letters and numbers only — no spaces, accents or punctuation.');
  }
  if (!/[A-Z]/.test(value)) {
    return no('A username needs at least one letter.');
  }
  if (RESERVED.has(value)) {
    return no('That one is reserved. Try another.');
  }
  return { ok: true, reason: null, value };
}

/** The link a person shares. The code is already the whole of the path. */
export function referralLink(baseUrl: string, code: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/r/${code}`;
}
