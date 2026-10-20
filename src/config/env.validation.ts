import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { keyModeProblem } from '../flutterwave/key-mode';
import { rateLimitEnvProblems } from '../rate-limit/policies';
import { isProxyAddress } from '../rate-limit/trust-proxy';

/**
 * Startup fails on anything missing or malformed. There is no Quidax sandbox,
 * so a process that boots with a half-configured key is a process that can move
 * real money by accident.
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int());

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number());

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: int(3000),
    API_PREFIX: z.string().default('v1'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    REDIS_HOST: z.string().default('localhost'),
    REDIS_PORT: int(6379),
    REDIS_PASSWORD: z.string().optional(),

    /**
     * How many reverse proxies sit in front of the API (spec §2.5). The client IP
     * every rate limit keys on is the X-Forwarded-For entry this many hops from
     * the right; anything further left was written by the client and is ignored.
     * Nginx in front: 1. Cloudflare then Nginx: 2.
     *
     * A hop count trusts whoever connects. Prefer TRUST_PROXY_ADDRESSES in
     * production; use this only where nothing but the proxy can reach the API.
     */
    TRUST_PROXY_HOPS: z
      .string()
      .optional()
      .transform((v) => (v === undefined || v === '' ? undefined : Number(v)))
      .pipe(z.number().int().min(0).max(5).optional()),

    /**
     * The reverse proxy's own address(es), comma-separated: `loopback` when
     * Nginx runs on the same machine, its private IP (or a CIDR) otherwise.
     * X-Forwarded-For is believed only on connections from these, so a client
     * that reaches the API port directly cannot fake its IP. Preferred over
     * TRUST_PROXY_HOPS; one of the two is required in production.
     */
    TRUST_PROXY_ADDRESSES: csv,

    /** Password hashes allowed at once per process (~32 MB each), and how many may wait (spec §4.3). */
    PASSWORD_HASH_CONCURRENCY: int(4),
    PASSWORD_HASH_QUEUE: int(32),

    QUIDAX_BASE_URL: z.string().url().default('https://openapi.quidax.io/exchange-open-api/api/v1'),
    QUIDAX_SECRET_KEY: z.string().optional(),
    QUIDAX_WEBHOOK_SECRET: z.string().optional(),
    QUIDAX_WEBHOOK_TOLERANCE_SECONDS: int(300),
    QUIDAX_RATE_LIMIT_PER_MINUTE: int(240),
    QUIDAX_ADDRESS_RATE_LIMIT_PER_SECOND: int(15),
    QUIDAX_BACKGROUND_RATE_LIMIT_PER_MINUTE: int(30),
    QUIDAX_USE_MOCK: bool(true),

    /**
     * Where uploaded files are kept (H8). "memory" is for development and
     * tests only: its files vanish on restart. "r2" is Cloudflare R2, a
     * private bucket; the four R2_* settings are then required.
     */
    STORAGE_DRIVER: z.enum(['memory', 'r2']).default('memory'),
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET: z.string().optional(),

    QUOTE_TTL_SECONDS: int(12),
    RATE_CACHE_TTL_SECONDS: int(3),
    QUOTE_HARD_EXPIRY_SECONDS: int(30),

    USER_ALIAS_EMAIL_DOMAIN: z.string().default('users.davochain.com'),
    TEST_ALIAS_EMAIL_DOMAIN: z.string().default('test.davochain.com'),

    /**
     * Where this API is reachable from the outside, used to build absolute URLs
     * an email client can load — a logo referenced as "/v1/site/logo" resolves
     * against the mail provider, not against us, so it never appears.
     */
    PUBLIC_API_URL: z.string().url().default('http://localhost:3000'),

    /**
     * Where the admin dashboard lives. An invitation email has to send a new
     * admin somewhere, and only the deployment knows where that is.
     */
    ADMIN_URL: z.string().url().default('http://localhost:3100'),

    /**
     * Which websites may call this API from inside somebody's browser.
     *
     * Comma-separated, full origins including the scheme:
     *   CORS_ORIGINS=https://admin.davochain.com,https://davochain.com
     *
     * This is a BROWSER rule and nothing else. The mobile app is unaffected —
     * CORS does not apply to it — and the admin dashboard talks to this API
     * from its own server with a bearer token, so it is unaffected too. It
     * matters only for a web page making authenticated calls from a visitor's
     * browser.
     *
     * Left empty in production, cross-origin browser calls are refused. That
     * is the safe default precisely because nothing depends on them today.
     * In development everything is allowed, so a local page on any port works.
     */
    CORS_ORIGINS: csv,

    /** How long an admin invitation link stays usable. */
    ADMIN_INVITE_TTL_HOURS: int(48),

    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_EXPIRES_IN: z.string().default('15m'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),
    ADMIN_JWT_SECRET: z.string().min(32, 'ADMIN_JWT_SECRET must be at least 32 characters'),
    ADMIN_JWT_EXPIRES_IN: z.string().default('8h'),

    /**
     * Minutes of inactivity before an admin session ends. The risk this guards
     * is a dashboard left open on an unlocked machine, which is why the clock
     * runs on idleness rather than on the age of the token.
     */
    ADMIN_IDLE_TIMEOUT_MINUTES: int(30),

    /**
     * Encrypts the partner secrets an admin stores in the database.
     *
     * It must NOT live in that database, or the encryption is decoration: a
     * stolen dump would carry both the ciphertext and the key. Lose this and
     * every stored credential is unreadable — which is the correct trade,
     * because the alternative is a backup that is itself the keys to the
     * business. Any length; it is hashed to 32 bytes.
     */
    CREDENTIALS_KEY: z.string().optional(),

    // ── Push (Firebase Cloud Messaging) ──────────────────────
    // All three or none. Missing credentials disable push; notifications are
    // still stored and readable at GET /v1/notifications. See docs/PUSH.md.
    FCM_PROJECT_ID: z.string().optional(),
    FCM_CLIENT_EMAIL: z.string().optional(),
    FCM_PRIVATE_KEY: z.string().optional(),

    SMTP_HOST: z.string().optional(),
    SMTP_PORT: int(587),
    SMTP_SECURE: bool(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM: z.string().default('Davochain <alerts@davochain.com>'),
    ALERT_DEFAULT_RECIPIENTS: csv,
    DAILY_DIGEST_HOUR: int(7),
    DIGEST_TIMEZONE: z.string().default('Africa/Lagos'),

    FEE_CLAIM_DESTINATION: z.string().default('usdt'),
    FEE_CLAIM_MIN_USD: num(1.5),

    TRADING_ENABLED: bool(true),
    NGN_WITHDRAWALS_ENABLED: bool(false),
    // ── Flutterwave (the naira rail) ──
    FLW_USE_MOCK: bool(true),
    FLW_BASE_URL: z.string().url().default('https://api.flutterwave.com/v3'),
    FLW_SECRET_KEY: z.string().optional(),
    FLW_SECRET_HASH: z.string().optional(),
    FLW_RATE_LIMIT_PER_MINUTE: int(120),
    NGN_DEPOSITS_ENABLED: bool(false),
    /** HMAC key for BVN/NIN hashes. Rotating it means users re-enter their number. */
    KYC_HASH_KEY: z.string().optional(),
    // ── Dojah (identity lookups and AML screening) ──
    DOJAH_USE_MOCK: bool(true),
    DOJAH_BASE_URL: z.string().url().default('https://sandbox.dojah.io'),
    DOJAH_APP_ID: z.string().optional(),
    DOJAH_SECRET_KEY: z.string().optional(),
    /** Naira. The hard stop: Basic refuses new submissions below it (plan §R2). Required in production. */
    DOJAH_MIN_BALANCE: z.string().optional(),
    /** Naira. A DOJAH_CONFIG "top up" alert fires below it (plan §R2). */
    DOJAH_LOW_BALANCE_WARN: z.string().optional(),
    /** Off until launch is verified (spec §14.6). */
    KYC_BASIC_ENABLED: bool(false),
    KYC_BASIC_DAILY_ATTEMPTS: int(3),
    KYC_BASIC_TOTAL_ATTEMPTS: int(10),
    // No longer read (level policy, 15 Oct 2026): set on System -> Verification levels.
    // Still accepted so existing .env files keep starting.
    MAX_TRADE_USD: num(2000),
    MAX_USER_DAILY_USD: num(5000),
    MAX_PLATFORM_DAILY_USD: num(50000),
    MARGIN_DEVIATION_TRIP_BPS: int(200),
  })
  .superRefine((env, ctx) => {
    const proxyAddresses = env.TRUST_PROXY_ADDRESSES ?? [];
    if (env.NODE_ENV === 'production' && env.TRUST_PROXY_HOPS === undefined && proxyAddresses.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TRUST_PROXY_HOPS'],
        message:
          'TRUST_PROXY_ADDRESSES (preferred) or TRUST_PROXY_HOPS is required in production; every rate limit keys on the client IP',
      });
    }
    // 0 hops behind Nginx makes every client look like Nginx: one shared bucket,
    // and one attacker locks everybody out of sign-in.
    if (env.NODE_ENV === 'production' && env.TRUST_PROXY_HOPS === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TRUST_PROXY_HOPS'],
        message: 'TRUST_PROXY_HOPS must be at least 1 in production (or use TRUST_PROXY_ADDRESSES)',
      });
    }
    if (env.TRUST_PROXY_HOPS !== undefined && proxyAddresses.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TRUST_PROXY_ADDRESSES'],
        message: 'Set TRUST_PROXY_ADDRESSES or TRUST_PROXY_HOPS, not both',
      });
    }
    for (const entry of proxyAddresses) {
      if (!isProxyAddress(entry)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TRUST_PROXY_ADDRESSES'],
          message: `"${entry}" is not an IP, an IP/prefix, or loopback/linklocal/uniquelocal`,
        });
      }
    }
    if (env.PASSWORD_HASH_CONCURRENCY < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PASSWORD_HASH_CONCURRENCY'],
        message: 'PASSWORD_HASH_CONCURRENCY must be at least 1',
      });
    }
    if (env.PASSWORD_HASH_QUEUE < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PASSWORD_HASH_QUEUE'],
        message: 'PASSWORD_HASH_QUEUE must be 0 or more',
      });
    }
    // The live key is only optional while the mock is in charge.
    if (!env.QUIDAX_USE_MOCK && !env.QUIDAX_SECRET_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['QUIDAX_SECRET_KEY'],
        message: 'QUIDAX_SECRET_KEY is required when QUIDAX_USE_MOCK=false',
      });
    }
    if (!env.QUIDAX_USE_MOCK && !env.QUIDAX_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['QUIDAX_WEBHOOK_SECRET'],
        message: 'QUIDAX_WEBHOOK_SECRET is required when QUIDAX_USE_MOCK=false',
      });
    }
    // Files kept in memory are gone after a restart; never where real documents arrive.
    if (env.STORAGE_DRIVER === 'memory' && !['development', 'test'].includes(env.NODE_ENV)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_DRIVER'],
        message: 'STORAGE_DRIVER=memory is only allowed in development and test; set STORAGE_DRIVER=r2',
      });
    }
    if (env.STORAGE_DRIVER === 'r2') {
      for (const name of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const) {
        if (!env[name]) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: `${name} is required when STORAGE_DRIVER=r2` });
        }
      }
      // The name, never the address: the code builds the address itself from R2_ACCOUNT_ID.
      const bucket = env.R2_BUCKET;
      if (bucket && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
        const fromUrl = /^https?:\/\/[^/]+\/([a-z0-9][a-z0-9-]{1,61}[a-z0-9])\/?$/.exec(bucket)?.[1];
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['R2_BUCKET'],
          message: fromUrl
            ? `R2_BUCKET takes only the bucket's name, not its address. Use R2_BUCKET=${fromUrl}`
            : "R2_BUCKET takes only the bucket's name (3-63 lowercase letters, numbers and hyphens), as shown in Cloudflare → R2",
        });
      }
    }
    // The Flutterwave mock accepts any deposit; it must never run where real people are.
    if (env.FLW_USE_MOCK && !['development', 'test'].includes(env.NODE_ENV)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FLW_USE_MOCK'],
        message: 'FLW_USE_MOCK=true is only allowed in development and test',
      });
    }
    // Live keys only in production; test keys everywhere else.
    if (!env.FLW_USE_MOCK && env.FLW_SECRET_KEY) {
      const problem = keyModeProblem(env.FLW_SECRET_KEY, env.NODE_ENV);
      if (problem) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['FLW_SECRET_KEY'], message: problem });
      }
    }
    if (env.KYC_HASH_KEY && env.KYC_HASH_KEY.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['KYC_HASH_KEY'],
        message: 'KYC_HASH_KEY must be at least 32 characters',
      });
    }
    // L5: it encrypts partner keys and gift-card codes; a short passphrase is a weak AES key.
    if ((env.NODE_ENV === 'staging' || env.NODE_ENV === 'production') && (env.CREDENTIALS_KEY ?? '').length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CREDENTIALS_KEY'],
        message: 'CREDENTIALS_KEY must be at least 32 characters in staging and production (e.g. openssl rand -base64 32)',
      });
    }
    if ((env.NODE_ENV === 'staging' || env.NODE_ENV === 'production') && !env.KYC_HASH_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['KYC_HASH_KEY'],
        message: 'KYC_HASH_KEY is required in staging and production',
      });
    }
    // The secret key rides in every request's Authorization header (spec §12.9).
    if ((env.NODE_ENV === 'staging' || env.NODE_ENV === 'production') && !env.FLW_BASE_URL.startsWith('https://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FLW_BASE_URL'],
        message: 'FLW_BASE_URL must use https in staging and production',
      });
    }
    // ── Dojah ──
    if (env.DOJAH_USE_MOCK && !['development', 'test'].includes(env.NODE_ENV)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DOJAH_USE_MOCK'], message: 'DOJAH_USE_MOCK=true is only allowed in development and test' });
    }
    {
      const host = new URL(env.DOJAH_BASE_URL).hostname;
      if ((env.NODE_ENV === 'staging' || env.NODE_ENV === 'production') && !env.DOJAH_BASE_URL.startsWith('https://')) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DOJAH_BASE_URL'], message: 'DOJAH_BASE_URL must use https in staging and production' });
      } else if (env.NODE_ENV === 'production' && !env.DOJAH_USE_MOCK && host !== 'api.dojah.io') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DOJAH_BASE_URL'], message: 'DOJAH_BASE_URL in production must use https://api.dojah.io' });
      } else if (env.NODE_ENV !== 'production' && host === 'api.dojah.io') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DOJAH_BASE_URL'], message: 'The live Dojah URL is only allowed in production; use https://sandbox.dojah.io' });
      }
    }
    const DECIMAL = /^\d+(\.\d{1,2})?$/;
    for (const key of ['DOJAH_MIN_BALANCE', 'DOJAH_LOW_BALANCE_WARN'] as const) {
      const v = env[key];
      if (v !== undefined && v !== '' && !DECIMAL.test(v)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} must be a plain decimal number of naira, e.g. 8000 or 8000.50` });
      }
    }
    if (env.NODE_ENV === 'production') {
      if (!env.DOJAH_MIN_BALANCE) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DOJAH_MIN_BALANCE'], message: 'DOJAH_MIN_BALANCE is required in production; compute it with scripts/dojah-threshold.ts (plan §R2)' });
      } else if (DECIMAL.test(env.DOJAH_MIN_BALANCE) && Number(env.DOJAH_MIN_BALANCE) <= 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DOJAH_MIN_BALANCE'], message: 'DOJAH_MIN_BALANCE must be greater than 0 in production' });
      }
    }
    if (
      env.DOJAH_LOW_BALANCE_WARN && env.DOJAH_MIN_BALANCE &&
      DECIMAL.test(env.DOJAH_LOW_BALANCE_WARN) && DECIMAL.test(env.DOJAH_MIN_BALANCE) &&
      Number(env.DOJAH_LOW_BALANCE_WARN) <= Number(env.DOJAH_MIN_BALANCE)
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DOJAH_LOW_BALANCE_WARN'], message: 'DOJAH_LOW_BALANCE_WARN must be greater than DOJAH_MIN_BALANCE' });
    }
    // Production must never quietly run against fixtures.
    // M13: the mock accepts unsigned webhooks; on staging anyone could credit balances.
    if (env.QUIDAX_USE_MOCK && !['development', 'test', 'production'].includes(env.NODE_ENV)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['QUIDAX_USE_MOCK'],
        message: 'QUIDAX_USE_MOCK=true is only allowed in development and test',
      });
    }
    if (env.NODE_ENV === 'production' && env.QUIDAX_USE_MOCK) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['QUIDAX_USE_MOCK'],
        message: 'QUIDAX_USE_MOCK must be false in production',
      });
    }
    // Partial FCM credentials are worse than none: the app looks configured
    // and silently sends nothing.
    const fcm = [env.FCM_PROJECT_ID, env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY];
    const present = fcm.filter(Boolean).length;
    if (present > 0 && present < 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FCM_PRIVATE_KEY'],
        message:
          'FCM needs all three of FCM_PROJECT_ID, FCM_CLIENT_EMAIL and FCM_PRIVATE_KEY, or none',
      });
    }
    if (env.FCM_PRIVATE_KEY && !env.FCM_PRIVATE_KEY.includes('PRIVATE KEY')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FCM_PRIVATE_KEY'],
        message:
          'FCM_PRIVATE_KEY does not look like a PEM. Copy private_key from the service account JSON verbatim, newlines included as \n',
      });
    }

    // A quote that outlives its hard expiry can be replayed against a stale price.
    if (env.QUOTE_TTL_SECONDS > env.QUOTE_HARD_EXPIRY_SECONDS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['QUOTE_TTL_SECONDS'],
        message: 'QUOTE_TTL_SECONDS must not exceed QUOTE_HARD_EXPIRY_SECONDS',
      });
    }
    // 12s must fit inside Quidax's own 15s quotation window.
    if (env.QUOTE_TTL_SECONDS >= 15) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['QUOTE_TTL_SECONDS'],
        message:
          'QUOTE_TTL_SECONDS must be under 15 — a Quidax swap quotation expires at 15 seconds',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Settings an old .env may still carry; accepted, never read. */
const RETIRED = ['MAX_TRADE_USD', 'MAX_USER_DAILY_USD', 'MAX_PLATFORM_DAILY_USD'];

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  const lines = parsed.success ? [] : parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`);
  // RATE_LIMIT_* overrides are read straight from the environment by the rate
  // limiter (they are not schema fields), so they are checked here instead.
  for (const problem of rateLimitEnvProblems(raw as Record<string, string | undefined>)) {
    lines.push(`  • ${problem}`);
  }
  const refuse = () => new Error(`Invalid environment configuration:\n${lines.join('\n')}\n`);
  if (!parsed.success) throw refuse();
  if (lines.length > 0) throw refuse();
  for (const key of RETIRED) {
    if (raw[key] !== undefined) new Logger('Env').warn(`${key} is no longer used: trading limits are set on System -> Verification levels.`);
  }
  return parsed.data;
}
