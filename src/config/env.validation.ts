import { z } from 'zod';

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

    QUIDAX_BASE_URL: z.string().url().default('https://openapi.quidax.io/exchange-open-api/api/v1'),
    QUIDAX_SECRET_KEY: z.string().optional(),
    QUIDAX_WEBHOOK_SECRET: z.string().optional(),
    QUIDAX_WEBHOOK_TOLERANCE_SECONDS: int(300),
    QUIDAX_RATE_LIMIT_PER_MINUTE: int(240),
    QUIDAX_ADDRESS_RATE_LIMIT_PER_SECOND: int(15),
    QUIDAX_BACKGROUND_RATE_LIMIT_PER_MINUTE: int(30),
    QUIDAX_USE_MOCK: bool(true),

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
    MAX_TRADE_USD: num(2000),
    MAX_USER_DAILY_USD: num(5000),
    MAX_PLATFORM_DAILY_USD: num(50000),
    MARGIN_DEVIATION_TRIP_BPS: int(200),
  })
  .superRefine((env, ctx) => {
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
    // Production must never quietly run against fixtures.
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

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}\n`);
  }
  return parsed.data;
}
