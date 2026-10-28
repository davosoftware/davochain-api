/**
 * The settings owners may change on the dashboard (System → Server settings),
 * spec 2026-10-26. Each keeps its .env name: a value nobody set on the
 * dashboard is the .env value, so nothing changes until someone edits one.
 *
 * Deliberately NOT here (they stay in .env; see the spec, "Group A"): the
 * database and Redis, the encryption and token-signing keys, the provider
 * addresses and mock switches, and how the server itself starts. Secrets live
 * on the API keys screen (credentials.service.ts), never on this one.
 *
 * Adding a setting: one entry here, then read it with ServerSettingsService.get.
 */

export type SettingKind =
  | { type: 'boolean' }
  | { type: 'int'; min: number; max: number; unit?: string }
  | { type: 'decimal'; min: number; max: number; unit?: string }
  /** A length of time written like 15m, 8h or 30d. Bounds in seconds. */
  | { type: 'duration'; units: Array<'m' | 'h' | 'd'>; minSeconds: number; maxSeconds: number }
  | { type: 'string'; maxLength: number; pattern?: RegExp; patternMessage?: string; allowEmpty?: boolean }
  | { type: 'account' }
  | { type: 'timezone' }
  | { type: 'asset' };

export interface SettingDef {
  key: string;
  group: string;
  label: string;
  help: string;
  kind: SettingKind;
  /** false: takes effect when the API next restarts (the screen says so). */
  live: boolean;
  /** Money-related: every owner is emailed when it changes (decision 26 Oct). */
  money: boolean;
}

const s = (def: SettingDef) => def;

export const SERVER_SETTINGS: SettingDef[] = [
  // ── Naira ────────────────────────────────────────────────
  s({ key: 'NGN_DEPOSITS_ENABLED', group: 'Naira', label: 'Naira deposits', help: 'Customers can get a naira account number and receive bank transfers.', kind: { type: 'boolean' }, live: true, money: true }),
  s({ key: 'NGN_ACCOUNT_AUTO_OPEN', group: 'Naira', label: 'Open naira accounts automatically', help: 'Open each customer\'s naira account by itself right after Basic verification.', kind: { type: 'boolean' }, live: true, money: false }),
  s({ key: 'PAYREP_MAIN_ACCOUNT', group: 'Naira', label: 'Main Payrep account', help: "DavoChain's own 10-digit Payrep account: the pool for customer accounts and the source of payouts. Payrep must recognise it.", kind: { type: 'account' }, live: true, money: true }),
  s({ key: 'PAYREP_ACCOUNT_NAME_PREFIX', group: 'Naira', label: 'Account name prefix', help: 'Put in front of the customer\'s name on new accounts, e.g. "DavoChain-". Leave empty when Payrep adds our name itself.', kind: { type: 'string', maxLength: 40, allowEmpty: true }, live: true, money: false }),

  // ── Crypto ───────────────────────────────────────────────
  s({ key: 'CRYPTO_ADDRESS_AUTO_CREATE', group: 'Crypto', label: 'Make crypto addresses in advance', help: 'Verified customers get the addresses switched on under People → Crypto addresses without opening Receive.', kind: { type: 'boolean' }, live: true, money: false }),

  // ── Sign-up ──────────────────────────────────────────────
  s({ key: 'CLOSED_ACCOUNT_DATA_RETENTION_MONTHS', group: 'Closed accounts', label: 'Delete closed customers after', help: "When an owner closes an account and chooses \"delete later\", the customer's personal details and documents are deleted this many months after closing. Their money records stay, without a name. Note: anti-money-laundering rules usually expect identity records to be kept for 5 years (60 months).", kind: { type: 'int', min: 1, max: 120, unit: 'months' }, live: true, money: false }),
  s({ key: 'EMAIL_VERIFICATION_REQUIRED', group: 'Sign-up', label: 'Customers must confirm their email', help: 'Until they type the emailed code, customers can look around but not move money. Switch off only if email sending is down.', kind: { type: 'boolean' }, live: true, money: true }),

  // ── Email sending (the password stays on the API keys screen) ──
  s({ key: 'SMTP_HOST', group: 'Email sending', label: 'Mail server', help: 'The SMTP server address, e.g. smtp.gmail.com.', kind: { type: 'string', maxLength: 253, pattern: /^[a-z0-9.-]+$/i, patternMessage: 'Enter a server name like smtp.example.com.' }, live: true, money: false }),
  s({ key: 'SMTP_PORT', group: 'Email sending', label: 'Port', help: 'Usually 587 (or 465 with "secure" on).', kind: { type: 'int', min: 1, max: 65535 }, live: true, money: false }),
  s({ key: 'SMTP_SECURE', group: 'Email sending', label: 'Secure connection from the start', help: 'On for port 465; off for 587.', kind: { type: 'boolean' }, live: true, money: false }),
  s({ key: 'SMTP_USER', group: 'Email sending', label: 'User name', help: 'The mail account to sign in with.', kind: { type: 'string', maxLength: 254, allowEmpty: true }, live: true, money: false }),
  s({ key: 'SMTP_FROM', group: 'Email sending', label: 'Sent from', help: 'Shown as the sender, e.g. DavoChain <support@davochain.com>.', kind: { type: 'string', maxLength: 200, pattern: /@/, patternMessage: 'Include an email address, e.g. DavoChain <support@davochain.com>.' }, live: true, money: false }),

  // ── Trading ──────────────────────────────────────────────
  s({ key: 'MARGIN_DEVIATION_TRIP_BPS', group: 'Trading', label: 'Price-move trip', help: "Trading pauses when Quidax's real price differs from ours by more than this percentage (e.g. 2%).", kind: { type: 'int', min: 10, max: 2000, unit: 'bps' }, live: true, money: false }),
  s({ key: 'QUOTE_TTL_SECONDS', group: 'Trading', label: 'Quote lifetime', help: 'How long a price quote is shown before the app asks for a new one. At most 14: a Quidax swap quotation expires at 15 seconds (the same rule as at start-up).', kind: { type: 'int', min: 5, max: 14, unit: 'seconds' }, live: true, money: false }),
  s({ key: 'QUOTE_HARD_EXPIRY_SECONDS', group: 'Trading', label: 'Quote hard expiry', help: 'After this, a quote can never be traded, even if the app still shows it.', kind: { type: 'int', min: 5, max: 300, unit: 'seconds' }, live: true, money: false }),
  s({ key: 'SWAP_REQUOTE_TOLERANCE_BPS', group: 'Trading', label: 'Swap price change allowed', help: "Quidax holds a swap price for about 15 seconds. If the customer taps Swap after that, a fresh price is used without asking if it gives them at most this much less (e.g. 0.5%). If it is worse, the customer is asked to accept the new price. This is not a fee: we earn nothing from it.", kind: { type: 'int', min: 0, max: 500, unit: 'bps' }, live: true, money: true }),
  s({ key: 'RATE_CACHE_TTL_SECONDS', group: 'Trading', label: 'Price cache', help: 'How long a price from Quidax is reused before asking again.', kind: { type: 'int', min: 1, max: 60, unit: 'seconds' }, live: true, money: false }),

  // ── Fees ─────────────────────────────────────────────────
  s({ key: 'FEE_CLAIM_DESTINATION', group: 'Fees', label: 'Collect fees as', help: 'The coin collected fees are converted to (a coin we list, e.g. usdt).', kind: { type: 'asset' }, live: true, money: true }),
  s({ key: 'FEE_CLAIM_MIN_USD', group: 'Fees', label: 'Smallest fee collection', help: 'Fees worth less than this (in US dollars) wait until there is more.', kind: { type: 'decimal', min: 0.5, max: 1000, unit: 'USD' }, live: true, money: true }),

  // ── Sessions ─────────────────────────────────────────────
  s({ key: 'JWT_EXPIRES_IN', group: 'Sessions', label: 'Customer sign-in token lifetime', help: 'How long a customer\'s access token lasts before the app refreshes it (e.g. 15m).', kind: { type: 'duration', units: ['m', 'h'], minSeconds: 5 * 60, maxSeconds: 60 * 60 }, live: true, money: false }),
  s({ key: 'JWT_REFRESH_EXPIRES_IN', group: 'Sessions', label: 'Customer stays signed in for', help: 'How long a customer stays signed in without typing the password again (e.g. 30d).', kind: { type: 'duration', units: ['d'], minSeconds: 86400, maxSeconds: 90 * 86400 }, live: true, money: false }),
  s({ key: 'ADMIN_JWT_EXPIRES_IN', group: 'Sessions', label: 'Admin session lifetime', help: 'How long an admin stays signed in (e.g. 8h).', kind: { type: 'duration', units: ['m', 'h'], minSeconds: 15 * 60, maxSeconds: 24 * 3600 }, live: true, money: false }),
  s({ key: 'ADMIN_IDLE_TIMEOUT_MINUTES', group: 'Sessions', label: 'Admin idle sign-out', help: 'An admin who does nothing for this long is signed out.', kind: { type: 'int', min: 5, max: 240, unit: 'minutes' }, live: true, money: false }),
  s({ key: 'ADMIN_INVITE_TTL_HOURS', group: 'Sessions', label: 'Admin invitation lifetime', help: 'How long an invitation link to join the dashboard works.', kind: { type: 'int', min: 1, max: 168, unit: 'hours' }, live: true, money: false }),

  // ── Reports ──────────────────────────────────────────────
  s({ key: 'DAILY_DIGEST_HOUR', group: 'Reports', label: 'Daily summary hour', help: 'The hour (0–23) the daily summary email is sent.', kind: { type: 'int', min: 0, max: 23 }, live: true, money: false }),
  s({ key: 'DIGEST_TIMEZONE', group: 'Reports', label: 'Daily summary time zone', help: 'e.g. Africa/Lagos.', kind: { type: 'timezone' }, live: true, money: false }),

  // ── Quidax ───────────────────────────────────────────────
  s({ key: 'QUIDAX_RATE_LIMIT_PER_MINUTE', group: 'Quidax speed limits', label: 'Calls per minute', help: 'Our own limit for normal calls to Quidax. Keep below what Quidax allows us.', kind: { type: 'int', min: 10, max: 1200, unit: 'per minute' }, live: true, money: false }),
  s({ key: 'QUIDAX_BACKGROUND_RATE_LIMIT_PER_MINUTE', group: 'Quidax speed limits', label: 'Background calls per minute', help: 'For sign-up and other work that can wait, so it never delays trades.', kind: { type: 'int', min: 1, max: 600, unit: 'per minute' }, live: true, money: false }),
  s({ key: 'QUIDAX_ADDRESS_RATE_LIMIT_PER_SECOND', group: 'Quidax speed limits', label: 'Address requests per second', help: 'For creating deposit addresses.', kind: { type: 'int', min: 1, max: 20, unit: 'per second' }, live: true, money: false }),
  s({ key: 'QUIDAX_WEBHOOK_TOLERANCE_SECONDS', group: 'Quidax speed limits', label: 'Oldest Quidax message accepted', help: 'Older messages are refused as possible replays.', kind: { type: 'int', min: 60, max: 3600, unit: 'seconds' }, live: true, money: false }),

  // ── File storage (the two keys live on the API keys screen) ──
  s({ key: 'R2_ACCOUNT_ID', group: 'File storage', label: 'Cloudflare account ID', help: 'From Cloudflare → R2. Used with the R2 keys on the API keys screen.', kind: { type: 'string', maxLength: 64, pattern: /^[a-f0-9]{32}$/i, patternMessage: 'A Cloudflare account ID is 32 letters and numbers.' }, live: true, money: false }),
  s({ key: 'R2_BUCKET', group: 'File storage', label: 'Bucket name', help: "Only the bucket's name (3–63 lowercase letters, numbers and hyphens), not its address.", kind: { type: 'string', maxLength: 63, pattern: /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, patternMessage: "Enter only the bucket's name, as shown in Cloudflare → R2." }, live: true, money: false }),

  // ── Broadcasts (29 Oct 2026) ─────────────────────────────
  s({ key: 'BROADCAST_PER_SECOND', group: 'Broadcasts', label: 'Customers per second', help: 'A message to all customers is sent by a background worker this many customers each second: their inbox message and a push to their phones. 100 sends 10,000 customers in under 2 minutes. Higher is faster but puts more load on the database at once.', kind: { type: 'int', min: 1, max: 1000, unit: 'per second' }, live: true, money: false }),
  s({ key: 'BROADCAST_EMAILS_PER_SECOND', group: 'Broadcasts', label: 'Customers per second, with email', help: 'Used instead when "Also send by email" is ticked. Mail servers limit how fast you may send; going over can get our mail marked as spam. 10 sends 10,000 customers in about 17 minutes. Ask your mail provider for its limit.', kind: { type: 'int', min: 1, max: 200, unit: 'per second' }, live: true, money: false }),

  // ── Push (the private key lives on the API keys screen) ──
  s({ key: 'FCM_PROJECT_ID', group: 'Push notifications', label: 'Firebase project ID', help: 'From the Firebase console. Applies after the API restarts.', kind: { type: 'string', maxLength: 100, pattern: /^[a-z0-9-]+$/, patternMessage: 'A Firebase project ID uses lowercase letters, numbers and hyphens.' }, live: false, money: false }),
  s({ key: 'FCM_CLIENT_EMAIL', group: 'Push notifications', label: 'Firebase service account email', help: 'Applies after the API restarts.', kind: { type: 'string', maxLength: 200, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/, patternMessage: 'Enter the service account email.' }, live: false, money: false }),
];

export type ServerSettingKey =
  | 'CRYPTO_ADDRESS_AUTO_CREATE'
  | 'NGN_DEPOSITS_ENABLED' | 'NGN_ACCOUNT_AUTO_OPEN' | 'PAYREP_MAIN_ACCOUNT' | 'PAYREP_ACCOUNT_NAME_PREFIX'
  | 'EMAIL_VERIFICATION_REQUIRED'
  | 'CLOSED_ACCOUNT_DATA_RETENTION_MONTHS'
  | 'BROADCAST_PER_SECOND' | 'BROADCAST_EMAILS_PER_SECOND'
  | 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_SECURE' | 'SMTP_USER' | 'SMTP_FROM'
  | 'MARGIN_DEVIATION_TRIP_BPS' | 'QUOTE_TTL_SECONDS' | 'QUOTE_HARD_EXPIRY_SECONDS' | 'SWAP_REQUOTE_TOLERANCE_BPS' | 'RATE_CACHE_TTL_SECONDS'
  | 'FEE_CLAIM_DESTINATION' | 'FEE_CLAIM_MIN_USD'
  | 'JWT_EXPIRES_IN' | 'JWT_REFRESH_EXPIRES_IN' | 'ADMIN_JWT_EXPIRES_IN' | 'ADMIN_IDLE_TIMEOUT_MINUTES' | 'ADMIN_INVITE_TTL_HOURS'
  | 'DAILY_DIGEST_HOUR' | 'DIGEST_TIMEZONE'
  | 'QUIDAX_RATE_LIMIT_PER_MINUTE' | 'QUIDAX_BACKGROUND_RATE_LIMIT_PER_MINUTE' | 'QUIDAX_ADDRESS_RATE_LIMIT_PER_SECOND' | 'QUIDAX_WEBHOOK_TOLERANCE_SECONDS'
  | 'R2_ACCOUNT_ID' | 'R2_BUCKET'
  | 'FCM_PROJECT_ID' | 'FCM_CLIENT_EMAIL';

export const SETTING_BY_KEY = new Map(SERVER_SETTINGS.map((d) => [d.key, d]));
