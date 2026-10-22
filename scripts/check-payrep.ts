/**
 * Checks DavoChain's Payrep integration against the Payrep TEST system
 * (spec 2026-10-20 §2.5, §11). Run only with the user's OK (plan Task 14).
 *
 * Run: CONFIRM_SANDBOX=yes npm run check:payrep
 *      optional: -- --intra 1234567890            name check on a Payrep (intra-bank) test account
 *                -- --intra 1234567890 --transfer  also send ₦1.00 to it, then repeat the same reference
 *
 * What it settles:
 *  - our test keys work, and the bank list and main account answer;
 *  - C3: a repeated reference is not paid twice, and Transaction Status still answers;
 *  - Review Focus 2: the real shape of fetch_transactions (it prints the KEYS of
 *    the reply and of its first item, so the parser's field names can be confirmed);
 *  - C1: the webhook signature recipe, using a delivery this API refused or accepted.
 *
 * It prints HTTP statuses, Payrep response codes, counts and key names only:
 * never a key, a token, a name, a full account number, a balance or a body.
 */
import 'dotenv/config';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { request } from 'undici';
import { PrismaClient } from '@prisma/client';
import { payrepKeyModeProblem } from '../src/payrep/key-mode';
import { classifyTransfer } from '../src/payrep/payrep.classify';
import { PAYREP_SANDBOX_URL } from '../src/payrep/payrep.config';
import { listOf } from '../src/payrep/payrep.parse';
import { payrepSignature } from '../src/payrep/webhook-signature';

type Obj = Record<string, unknown>;
const env = (k: string) => (process.env[k] ?? '').trim();
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);
const keysOf = (v: unknown) => (v && typeof v === 'object' ? Object.keys(v as object).join(', ') || '(none)' : typeof v);
const last4 = (s: string) => `••••${s.slice(-4)}`;
let failures = 0;
const ok = (label: string, detail = '') => console.log(`✓ ${label}${detail ? `: ${detail}` : ''}`);
const bad = (label: string, detail = '') => {
  failures++;
  console.log(`✗ ${label}${detail ? `: ${detail}` : ''}`);
};

const base = (env('PAYREP_BASE_URL') || PAYREP_SANDBOX_URL).replace(/\/+$/, '');
let token = '';

async function post(path: string, body: Obj | null, auth = true): Promise<{ status: number; body: Obj | undefined }> {
  const res = await request(`${base}/api/v1${path}`, {
    method: body === null ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
    headersTimeout: 30_000,
    bodyTimeout: 30_000,
  });
  const text = await res.body.text();
  let parsed: Obj | undefined;
  try {
    parsed = text ? (JSON.parse(text) as Obj) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: res.statusCode, body: parsed };
}
const code = (r: { status: number; body: Obj | undefined }) => `HTTP ${r.status}, code ${String(r.body?.response_code ?? '-')}`;

/** What the transaction list shows for one of our references: how DavoChain decides a transfer's outcome. */
async function listed(reference: string): Promise<string> {
  const day = (o: number) => new Date(Date.now() + o * 86_400_000).toISOString().slice(0, 10);
  const r = await post('/transaction/api/fetch_transactions', { filters: { reference_number: reference, start_date: day(-2), end_date: day(1) }, limit: 10 });
  const items = (listOf(r.body?.data) ?? []).filter((i) => String((i as Obj).reference_number) === reference);
  return `${code(r)}, ${items.length} record(s)${items.length ? `: ${items.map((i) => `${String((i as Obj).transaction_type)} ${String((i as Obj).status)}${(i as Obj).is_reversed ? ' (reversed)' : ''}`).join(', ')}` : ''}`;
}

async function main(): Promise<void> {
  if (base !== PAYREP_SANDBOX_URL || env('CONFIRM_SANDBOX') !== 'yes') {
    console.error(`Refusing: this runs only against the Payrep test system (${PAYREP_SANDBOX_URL}) with CONFIRM_SANDBOX=yes.`);
    process.exit(2);
  }
  const clientId = env('PAYREP_CLIENT_ID');
  const clientSecret = env('PAYREP_CLIENT_SECRET');
  let main = env('PAYREP_MAIN_ACCOUNT');
  if (!clientId || !clientSecret) {
    console.error('Refusing: PAYREP_CLIENT_ID and PAYREP_CLIENT_SECRET must be set in api/.env.');
    process.exit(2);
  }
  const mode = payrepKeyModeProblem(clientId, clientSecret, 'development');
  if (mode) {
    console.error(`Refusing: ${mode}`);
    process.exit(2);
  }

  // 1. Token
  const t = await post('/security/api/generate_token', { client_id: clientId, client_secret: clientSecret }, false);
  // The sandbox puts the token in message.data (data is null); the docs say data.
  const tokenBox = ((t.body?.data as Obj | undefined) ?? ((t.body?.message as Obj | undefined)?.data as Obj | undefined)) ?? {};
  token = String(tokenBox.access_token ?? '');
  if (!token) {
    bad('token', code(t));
    return;
  }
  ok('token', `${code(t)}, expires_in ${String(tokenBox.expires_in ?? '?')}s`);

  // Our main account, as Payrep knows it. Used for this run when PAYREP_MAIN_ACCOUNT is empty.
  const primary = await post('/account/api/get_primary_account', null);
  const primaryNo = String(((primary.body?.data as Obj | undefined)?.account_number as string | undefined) ?? '');
  if (primaryNo) ok('Payrep main account', `${code(primary)}, ends ${last4(primaryNo)}${main ? (main === primaryNo ? ' (matches PAYREP_MAIN_ACCOUNT)' : ' — DIFFERENT from PAYREP_MAIN_ACCOUNT') : ' — put this number in PAYREP_MAIN_ACCOUNT'}`);
  else bad('Payrep main account', `${code(primary)}; data keys ${keysOf(primary.body?.data)}`);
  if (!main) main = primaryNo;
  if (!main) return;

  // 2. Banks
  const banks = await post('/transaction/transfer/api/fetch_banks', {});
  const list = (listOf(banks.body?.data) ?? []) as Obj[];
  if (list.length) ok('bank list', `${code(banks)}, ${list.length} banks; Access Bank code ${String(list.find((b) => /^access/i.test(String(b.name)))?.code ?? 'not listed')}`);
  else bad('bank list', code(banks));

  // 3. Our main account
  const acc = await post('/account/api/get_account_balance', { account_number: main });
  const accData = acc.body?.data as Obj | undefined;
  if (accData) ok(`main account ${last4(main)}`, `${code(acc)}, status "${String(accData.status)}", balance ${accData.balance !== undefined ? 'present' : 'missing'}, name ${accData.account_name ? 'present' : 'missing'}`);
  else bad(`main account ${last4(main)}`, code(acc));

  // 4. Name check (and optionally a ₦1 transfer) on an intra-bank test account
  const intra = arg('intra');
  if (intra) {
    const ne = await post('/transaction/transfer/api/name_enquiry', { beneficiary_account_number: intra, bank_code: '090823', source_account_number: main });
    const neData = ne.body?.data as Obj | undefined;
    if (neData?.beneficiary_account_name) ok(`name check ${last4(intra)}`, `${code(ne)}, transfer_type "${String(neData.transfer_type)}", session_id ${neData.session_id ? 'present' : 'missing'}`);
    else bad(`name check ${last4(intra)}`, code(ne));

    if (flag('transfer') && neData?.beneficiary_account_name) {
      const reference = `chk_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const body = {
        source_account_number: main,
        source_account_name: String(accData?.account_name ?? ''),
        beneficiary_account_number: intra,
        beneficiary_account_name: String(neData.beneficiary_account_name),
        bank_code: '090823',
        bank_name: String(neData.bank_name ?? 'Payrep MFB'),
        amount: '1.00',
        transfer_type: 'intra',
        reference_number: reference,
        remarks: 'DavoChain check',
        ...(neData.session_id ? { session_id: String(neData.session_id) } : {}),
      };
      const first = await post('/transaction/transfer/api/funds_transfer', body);
      console.log(`  first send: ${code(first)} → our reading: ${classifyTransfer(first.status, first.body).kind}; message: "${String(first.body?.message ?? '')}"`);
      console.log(`  as DavoChain reads it (transaction list by reference): ${await listed(reference)}`);
      const again = await post('/transaction/transfer/api/funds_transfer', body);
      const kind = classifyTransfer(again.status, again.body).kind;
      console.log(`  same reference again: ${code(again)} → our reading: ${kind}; message: "${String(again.body?.message ?? '')}"`);
      console.log(`  after the repeat, the list shows: ${await listed(reference)}`);
      if (kind === 'SENT') bad('C3 duplicate reference', 'Payrep accepted the same reference twice: check the account for a second ₦1 debit');
      else ok('C3 duplicate reference', 'the repeat was not accepted as a new transfer');
    }
  } else {
    console.log('- name check and transfer skipped (pass --intra <10-digit Payrep test account>)');
  }

  // 5. The shape of fetch_transactions
  const today = new Date();
  const from = new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10);
  // The same filters and page size the sweep uses, over two pages.
  const filters = { transaction_type: 'credit', start_date: from, end_date: today.toISOString().slice(0, 10) };
  const tx = await post('/transaction/api/fetch_transactions', { filters, limit: 2, page_size: 2 });
  const items = listOf(tx.body?.data);
  if (!items) {
    bad('fetch_transactions', `${code(tx)}; a shape DavoChain cannot read: data keys ${keysOf(tx.body?.data)}`);
  } else {
    ok('fetch_transactions', `${code(tx)}; data is ${Array.isArray(tx.body?.data) ? 'a list' : `an object with keys: ${keysOf(tx.body?.data)}`}; ${items.length} item(s)`);
    if (items.length) {
      console.log(`  first item keys: ${keysOf(items[0])}`);
      // Values of these two fields only (never amounts, names or numbers): the deposit code acts on them.
      const distinct = (k: string) => [...new Set(items.map((i) => String((i as Obj)[k] ?? '(missing)')))].join(', ');
      console.log(`  status values: ${distinct('status')}; transaction_type values: ${distinct('transaction_type')}`);
      const last = items[items.length - 1] as Obj;
      const page2 = await post('/transaction/api/fetch_transactions', {
        filters,
        limit: 2,
        page_size: 2,
        cursor_created_at: String(last.created_at ?? ''),
        cursor_id: String(last.transaction_id ?? last.id ?? ''),
      });
      const items2 = listOf(page2.body?.data) ?? [];
      const repeated = items2.some((i) => String((i as Obj).transaction_id ?? (i as Obj).id) === String(last.transaction_id ?? last.id));
      console.log(`  page 2 by cursor: ${code(page2)}, ${items2.length} item(s)${repeated ? ' — REPEATS page 1: the cursor is ignored' : ''}; next_cursor ${(page2.body?.data as Obj | undefined)?.next_cursor ? 'present' : 'absent'}`);
    } else {
      console.log('  no items in the last day: make a test deposit first to see an item\'s keys');
    }
  }

  // 6. C1: the webhook signature recipe, from deliveries this API recorded (local database only).
  //    Note: on a development machine these rows may come from the automated tests, which sign with the
  //    pretend secret; only a delivery Payrep itself sent proves the recipe.
  console.log('- webhook recipe (local database rows; on a dev machine they may be from automated tests):');
  const secret = env('PAYREP_WEBHOOK_SECRET');
  if (!/^[0-9a-f]{64}$/i.test(secret)) {
    bad('webhook recipe', 'PAYREP_WEBHOOK_SECRET is not set (64 hex characters)');
  } else {
    const prisma = new PrismaClient();
    try {
      const refused = await prisma.webhookEvent.findFirst({ where: { eventName: 'payrep.unauthenticated' }, orderBy: { receivedAt: 'desc' } });
      const capture = (refused?.payload as Obj | null)?.capture as { timestamp?: string; signature?: string; body?: string } | null | undefined;
      if (capture?.timestamp && capture.signature && capture.body) {
        const expected = Buffer.from(payrepSignature(secret, capture.timestamp, Buffer.from(capture.body, 'base64')));
        const given = Buffer.from(capture.signature.trim().toLowerCase());
        const matches = given.length === expected.length && timingSafeEqual(given, expected);
        console.log(`  newest refused delivery (${refused!.receivedAt.toISOString()}): documented recipe matches: ${matches ? 'yes (so it was refused for its age or our secret changed since)' : 'NO'}`);
        if (!matches) bad('webhook recipe', 'a delivery Payrep signed does not match "{X-Timestamp}:{body}" with this secret: check the secret, then tell Payrep');
      }
      const accepted = await prisma.webhookEvent.findFirst({ where: { eventName: { startsWith: 'payrep.' }, signatureValid: true }, orderBy: { receivedAt: 'desc' } });
      if (accepted) ok('webhook recipe', `a real Payrep webhook was accepted with the documented recipe (${accepted.eventName}, ${accepted.receivedAt.toISOString()})`);
      else if (!capture) console.log('- webhook recipe: no Payrep delivery recorded yet (register the webhook URL and make a test deposit, then run this again)');
    } finally {
      await prisma.$disconnect();
    }
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) need attention.` : '\nAll checks that ran passed.');
    if (failures) process.exitCode = 1;
  })
  .catch((e: Error) => {
    console.error(`Stopped: ${e.message}`);
    process.exitCode = 1;
  });
