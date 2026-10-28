/**
 * Prints every HTTP route the API serves, read from the controllers' own
 * decorators (no server needed): method, path, who may call it, the KYC level,
 * the admin permission, the rate-limit policy, maintenance pausing, and the
 * request body's fields with their validation rules.
 *
 * Run: npx ts-node --transpile-only --compiler-options '{"module":"CommonJS"}' scripts/route-inventory.ts > route-inventory.md
 */
import 'reflect-metadata';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA, GUARDS_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { getMetadataStorage } from 'class-validator';

const SRC = join(__dirname, '..', 'src');
const PREFIX = '/v1';
/** main.ts: setGlobalPrefix(..., { exclude: [...] }). Providers and load balancers call these without /v1. */
const UNPREFIXED = new Set(['/health', '/webhooks/quidax', '/webhooks/payrep']);

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return controllerFiles(full);
    return name.endsWith('.controller.ts') ? [full] : [];
  });
}

function join2(a: string, b: string): string {
  const parts = [a, b].map((p) => (p ?? '').replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return '/' + parts.join('/');
}

/** class-validator rules for one DTO class, as "field: rule, rule". Nested DTOs are expanded one level. */
function bodyFields(dto: unknown, depth = 0): string[] {
  if (typeof dto !== 'function' || ['Object', 'String', 'Number', 'Boolean', 'Array'].includes((dto as { name: string }).name)) return [];
  const storage = getMetadataStorage();
  const metas = storage.getTargetValidationMetadatas(dto as never, '', true, false);
  const byField = new Map<string, Set<string>>();
  const nested = new Map<string, unknown>();
  for (const m of metas) {
    const set = byField.get(m.propertyName) ?? new Set<string>();
    const name = m.name ?? (m.type as string);
    if (name === 'isOptional' || m.type === 'conditionalValidation') set.add('optional');
    else if (m.type === 'nestedValidation') {
      set.add('object');
      const t = Reflect.getMetadata('design:type', (dto as { prototype: object }).prototype, m.propertyName);
      if (t) nested.set(m.propertyName, t);
    } else if (name) {
      const c = (m.constraints ?? []).filter((x: unknown) => typeof x !== 'object' || x instanceof RegExp || Array.isArray(x));
      const shown = c.length ? `${name}(${c.map((x: unknown) => (x instanceof RegExp ? x.source : Array.isArray(x) ? x.join('|') : String(x))).join(', ')})` : name;
      set.add(shown.length > 70 ? shown.slice(0, 67) + '…' : shown);
    }
    byField.set(m.propertyName, set);
  }
  const lines: string[] = [];
  for (const [field, rules] of byField) {
    const pad = '  '.repeat(depth);
    const req = rules.has('optional') ? 'optional' : 'required';
    rules.delete('optional');
    lines.push(`${pad}- \`${field}\` (${req}): ${[...rules].join(', ') || 'any'}`);
    if (nested.has(field) && depth < 2) lines.push(...bodyFields(nested.get(field), depth + 1));
  }
  return lines;
}

interface Row { method: string; path: string; access: string; kyc: string; perms: string; limit: string; paused: boolean; body: string[]; query: string[]; file: string; group: string }

const rows: Row[] = [];
for (const file of controllerFiles(SRC)) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(file) as Record<string, unknown>;
  for (const exported of Object.values(mod)) {
    if (typeof exported !== 'function' || Reflect.getMetadata(PATH_METADATA, exported) === undefined) continue;
    const cls = exported as unknown as { prototype: Record<string, unknown>; name: string };
    const base = Reflect.getMetadata(PATH_METADATA, cls) as string;
    const clsPublic = Reflect.getMetadata('isPublic', cls) === true;
    const clsGuards = (Reflect.getMetadata(GUARDS_METADATA, cls) ?? []) as { name?: string }[];
    const clsLimit = Reflect.getMetadata('rateLimitPolicy', cls) as string | undefined;
    for (const key of Object.getOwnPropertyNames(cls.prototype)) {
      if (key === 'constructor') continue;
      const handler = cls.prototype[key] as object;
      const sub = Reflect.getMetadata(PATH_METADATA, handler);
      if (sub === undefined) continue;
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
      const subs = Array.isArray(sub) ? sub : [sub];
      const isPublic = Reflect.getMetadata('isPublic', handler) === true || clsPublic;
      const adminGuard = [...clsGuards, ...((Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as { name?: string }[])].some((g) => g?.name === 'AdminGuard');
      const tier = Reflect.getMetadata('requiredTier', handler) as string | undefined;
      // Level policy: the admin's rule for this action decides (QUOTE_SIDE = the quote's buy/sell/swap).
      const action = Reflect.getMetadata('requiredAction', handler) as string | undefined;
      const perms = (Reflect.getMetadata('admin:permissions', handler) ?? Reflect.getMetadata('admin:permissions', cls) ?? []) as string[];
      const limit = (Reflect.getMetadata('rateLimitPolicy', handler) as string | undefined) ?? clsLimit ?? 'default';
      const paused = Reflect.getMetadata('pausedInMaintenance', handler) === true;
      const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, cls, key) ?? {}) as Record<string, { index: number; data?: string }>;
      const types = (Reflect.getMetadata('design:paramtypes', cls.prototype, key) ?? []) as unknown[];
      const body: string[] = [];
      const query: string[] = [];
      for (const [k, a] of Object.entries(args)) {
        const kind = Number(k.split(':')[0]);
        if (kind === 3) body.push(...(a.data ? [`- \`${a.data}\``] : bodyFields(types[a.index])));
        if (kind === 4) {
          // A whole query class (@Query() dto): list its fields like a body's, marked as query.
          const fields = a.data ? [] : bodyFields(types[a.index]);
          if (a.data) query.push(`\`${a.data}\``);
          else if (fields.length) body.push(...fields.map((l) => l.replace(/^(\s*)- /, '$1- (query) ')));
          else query.push('(object)');
        }
      }
      for (const s of subs) {
        rows.push({
          method,
          path: UNPREFIXED.has(join2(base, s)) ? join2(base, s) : PREFIX + join2(base, s),
          access: adminGuard ? 'admin token' : isPublic ? 'none (public)' : 'user token',
          kyc: action ? `level rule: ${action === 'QUOTE_SIDE' ? 'BUY/SELL/SWAP' : action}` : tier ? `${tier} + AML CLEAR` : '',
          perms: perms.join(' + '),
          limit,
          paused,
          body,
          query,
          file: relative(join(__dirname, '..'), file).replace(/\\/g, '/'),
          group: base.split('/')[0] || base,
        });
      }
    }
  }
}

rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
const out: string[] = [];
out.push(`<!-- Generated by scripts/route-inventory.ts on ${new Date().toISOString().slice(0, 10)}. ${rows.length} routes. Do not edit by hand. -->`);
out.push('');
// Behaviour the table below can't show (a route's fields can stay the same while what it does changes).
// Newest first; keep each line short and point to the app guide for detail.
const RECENT_CHANGES: Array<[string, string]> = [
  ['28 Oct 2026', 'Send crypto by payment username: `PUT /v1/me/pay-username`, `GET /v1/me/pay-username/check`, `GET /v1/transfers/recipient`, `POST /v1/transfers/crypto` (free, instant; `password` for a first send of 100,000 naira or more). A crypto withdrawal to another DavoChain customer address now moves inside DavoChain, free, and reaches them (before, they were never credited). `GET /v1/withdrawals/quote` takes `savedCryptoAddressId`. Histories add `to` / `from`. Admin: `DELETE /v1/admin/users/:id/pay-username` (reason; users.manage); user detail adds `payUsername`; transaction rows add `peer`.'],
  ['28 Oct 2026', 'Admin: closing now asks what happens to the data. `POST /v1/admin/users/:id/close` takes `dataChoice`: `KEEP` (default), `DELETE_LATER` (deleted automatically after `CLOSED_ACCOUNT_DATA_RETENTION_MONTHS`, 6 by default, on System → Server settings) or `DELETE_NOW`. New `POST /v1/admin/users/:id/delete-data` (owners; `password`, `reason`) deletes a closed account data later. Deleting removes name, email, phone, date of birth, address, BVN/NIN, documents and photos, verification and screening records; money records stay as "Deleted customer".'],
  ['28 Oct 2026', 'Admin: close a customer account. `GET /v1/admin/users/:id/close-check` (what stops it: money held, transactions in progress, gift card sales waiting) and `POST /v1/admin/users/:id/close` (owners only; `password`, `reason`). Refused with `409 code: ACCOUNT_NOT_EMPTY` while anything is left. The account is kept (records stay), its sign-in ends for good, its naira account is switched off, and its email and phone are freed for a new sign-up; the same BVN/NIN can verify the new account. For the app: nothing new; a closed customer simply cannot sign in.'],
  ['28 Oct 2026', '`GET /v1/me` adds `dateOfBirth` (verified, YYYY-MM-DD, null before Basic). Admin: `GET /v1/admin/users/:id` adds `kyc.dateOfBirth`; `GET /v1/admin/kyc/advanced` adds `recentRejected` (the latest 20 rejections, with both dates for a birth-date mismatch) and `pretendDojah`.'],
  ['28 Oct 2026', 'New public `GET /v1/rates`: every listed coin with its naira buy and sell price (for a $100 trade) and dollar price, built like a quote and refreshed at most every 30 s. For the markets screen; the trade price is still the quote (FLUTTER_API.md 5.3).'],
  ['27 Oct 2026', 'Admin: `GET /v1/admin/limits/daily` (a Lagos day: `date`, `action`, `near`, `search`, `page`) and `GET /v1/admin/users/:id/limits`: each customer use of each verification-level daily limit, counted exactly as the limits check counts it. Nothing changes for the app.'],
  ['27 Oct 2026', 'Swaps: priced from Quidax own live swap price with the DavoChain swap fee on top, so the user receives what was shown. The app should refresh a swap quote every ~10 s while the screen is open. `POST /v1/trades` for a swap whose price expired (up to 30 s) picks up the current price and goes ahead if at most 0.5% worse, else answers `409 code: PRICE_CHANGED` with a new quote. Trade history and `GET /v1/trades/:id` show a swap fee (`fee`, `feeAsset`) and small rates with their digits. (FLUTTER_API.md 7.1-7.4)'],
  ['26 Oct 2026', 'Crypto deposit addresses: `status` can now be **`FAILED`** (Quidax never delivered it); show "We could not create your address" + **Try again** = the same `POST /v1/deposits/address`. New push `address.failed`. BTC, USDT (trc20) and USDT (bep20) are made in advance after Basic, so they are often `ACTIVE` on the first call. New admin routes `GET /v1/admin/deposit-addresses`, `POST /v1/admin/deposit-addresses/:id/retry`, `GET /v1/admin/asset-networks`, `PUT /v1/admin/asset-networks/:asset/:network/auto-create`. (Reports/FLUTTER_CRYPTO_ADDRESSES.md)'],
  ['26 Oct 2026', 'Any customer request can now answer `401 "Session expired. Please sign in again."` after an owner uses the emergency **sign out all customers**; the app should send the person to sign in (a refresh also fails). New owner-only admin routes `GET/PUT/DELETE /v1/admin/server-settings` and `POST /v1/admin/emergency/sign-out-customers`.'],
  ['26 Oct 2026', 'Admin `GET /v1/admin/kyc/pending` is paged: `order` (oldest|newest), `page`, `pageSize` (max 100), `search` (email or name), `includeAutomatedTests`; it answers `{ items, total, page, pageSize, order }` instead of a bare list of the oldest 100.'],
  ['23 Oct 2026', '`GET`/`POST /v1/deposits/ngn/account`: **no BVN or NIN**. The naira account opens by itself after Basic approval (Payrep `create_account`, named from the ID). GET answers `200` with the number, or `202 {status:"PENDING"}` while it opens; its 404 is only for someone not eligible. POST needs no body; `bvn`/`nin` are still accepted for old app builds and ignored. New push `ngn_account.ready`. (FLUTTER_API.md 6.4, 6.5)'],
  ['23 Oct 2026', '`tier`, `currentTier` and `requiredTier` are the **old names**: build on `level` (None, Basic, Advanced) and `requiredLevel`. (FLUTTER_API.md §0.6.1)'],
  ['23 Oct 2026', 'Basic or Advanced approval ends every session: the app signs in again; a refresh then answers 401. (FLUTTER_API.md §0.5)'],
  ['22 Oct 2026', '`POST /v1/auth/email/send-code` and `/email/verify`: customers confirm their email before money, verification or a naira account (`403 code: EMAIL_NOT_VERIFIED`).'],
];
out.push('## Recent changes the table cannot show');
out.push('');
out.push('| Date | Change |');
out.push('| --- | --- |');
for (const [date, change] of RECENT_CHANGES) out.push(`| ${date} | ${change} |`);
out.push('');
out.push('## Routes');
out.push('');
out.push('| Method | Path | Auth | KYC | Admin permission | Rate limit | Paused in maintenance |');
out.push('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) out.push(`| ${r.method} | \`${r.path}\` | ${r.access} | ${r.kyc} | ${r.perms} | ${r.limit} | ${r.paused ? 'yes' : ''} |`);
out.push('');
out.push('### Request bodies and query parameters, by route');
out.push('');
for (const r of rows) {
  if (!r.body.length && !r.query.length) continue;
  out.push(`**${r.method} \`${r.path}\`** (${r.file})`);
  if (r.query.length) out.push(`- Query: ${r.query.join(', ')}`);
  if (r.body.length) out.push(...r.body);
  out.push('');
}
console.log(out.join('\n'));
