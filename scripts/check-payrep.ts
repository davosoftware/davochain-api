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
import { classifyStatus, classifyTransfer } from '../src/payrep/payrep.classify';
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

async function post(path: string, body: Obj, auth = true): Promise<{ status: number; body: Obj | undefined }> {
  const res = await request(`${base}/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
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

async function main(): Promise<void> {
  if (base !== PAYREP_SANDBOX_URL || env('CONFIRM_SANDBOX') !== 'yes') {
    console.error(`Refusing: this runs only against the Payrep test system (${PAYREP_SANDBOX_URL}) with CONFIRM_SANDBOX=yes.`);
    process.exit(2);
  }
  const clientId = env('PAYREP_CLIENT_ID');
  const clientSecret = env('PAYREP_CLIENT_SECRET');
  const main = env('PAYREP_MAIN_ACCOUNT');
  if (!clientId || !clientSecret || !main) {
    console.error('Refusing: PAYREP_CLIENT_ID, PAYREP_CLIENT_SECRET and PAYREP_MAIN_ACCOUNT must be set in api/.env.');
    process.exit(2);
  }
  const mode = payrepKeyModeProblem(clientId, clientSecret, 'development');
  if (mode) {
    console.error(`Refusing: ${mode}`);
    process.exit(2);
  }

  // 1. Token
  const t = await post('/security/api/generate_token', { client_id: clientId, client_secret: clientSecret }, false);
  token = String((t.body?.data as Obj | undefined)?.access_token ?? '');
  if (!token) {
    bad('token', code(t));
    return;
  }
  ok('token', `${code(t)}, expires_in ${String((t.body?.data as Obj).expires_in ?? '?')}s`);

  // 2. Banks
  const banks = await post('/transaction/transfer/api/fetch_banks', {});
  const list = listOf(banks.body?.data) as Obj[];
  if (list.length) ok('bank list', `${code(banks)}, ${list.length} banks, Access 000014 ${list.some((b) => b.code === '000014') ? 'present' : 'MISSING'}`);
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
      const s1 = await post('/transaction/transfer/api/transaction_status', { reference_number: reference });
      console.log(`  status: ${code(s1)} → ${JSON.stringify(classifyStatus(s1.status, s1.body))}`);
      const again = await post('/transaction/transfer/api/funds_transfer', body);
      const kind = classifyTransfer(again.status, again.body).kind;
      console.log(`  same reference again: ${code(again)} → our reading: ${kind}; message: "${String(again.body?.message ?? '')}"`);
      const s2 = await post('/transaction/transfer/api/transaction_status', { reference_number: reference });
      console.log(`  status again: ${code(s2)} → ${JSON.stringify(classifyStatus(s2.status, s2.body))}`);
      if (kind === 'SENT') bad('C3 duplicate reference', 'Payrep accepted the same reference twice: check the account for a second ₦1 debit');
      else ok('C3 duplicate reference', 'the repeat was not accepted as a new transfer');
    }
  } else {
    console.log('- name check and transfer skipped (pass --intra <10-digit Payrep test account>)');
  }

  // 5. The shape of fetch_transactions
  const today = new Date();
  const from = new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10);
  const tx = await post('/transaction/api/fetch_transactions', { filters: { start_date: from, end_date: today.toISOString().slice(0, 10) }, limit: 5 });
  const items = listOf(tx.body?.data);
  ok('fetch_transactions', `${code(tx)}; data is ${Array.isArray(tx.body?.data) ? 'a list' : `an object with keys: ${keysOf(tx.body?.data)}`}; ${items.length} item(s)`);
  if (items.length) console.log(`  first item keys: ${keysOf(items[0])}`);
  else console.log('  no items in the last day: make a test deposit first to see an item\'s keys');

  // 6. C1: the webhook signature recipe, from deliveries this API recorded (local database only)
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
