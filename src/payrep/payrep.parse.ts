import type { PayrepCollection } from './payrep.types';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const s = (v: unknown, max = 200): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
const money = (v: unknown): string | null => {
  const t = s(v, 40);
  return t && /^\d+(\.\d+)?$/.test(t) ? t : null;
};

/**
 * Where a list hides in a reply whose shape Payrep doesn't document. No data is
 * an empty list; a shape we don't recognise is null ("unreadable"), so a caller
 * can never mistake it for "nothing there".
 */
export function listOf(data: unknown): unknown[] | null {
  if (data === null || data === undefined) return [];
  if (Array.isArray(data)) return data;
  const o = obj(data);
  for (const k of ['results', 'transactions', 'data', 'items']) if (o && Array.isArray(o[k])) return o[k] as unknown[];
  return null;
}

/** Payrep's own next-page pointer, when the reply carries one. */
export function nextCursorOf(data: unknown): { createdAt: string; id: string } | null {
  const c = obj(obj(data)?.next_cursor);
  const createdAt = s(c?.cursor_created_at, 40);
  const id = s(c?.cursor_id);
  return createdAt && id ? { createdAt, id } : null;
}

/**
 * The one id a deposit carries both in Payrep's webhook and in its transaction list.
 * The sandbox (22 Oct 2026) sends no transaction_id in either, and reference_number
 * is null on a collection webhook; the bank's third_party_reference_number is in both.
 */
export function collectionKey(raw: unknown): string | null {
  const o = obj(raw);
  if (!o) return null;
  return s(o.third_party_reference_number) ?? s(o.reference_number) ?? s(o.transaction_id) ?? s(o.id);
}

/**
 * One credit, or null when it lacks an id or a readable amount (never guessed).
 * Reads both the documented names and the ones the sandbox really uses:
 * our account in account__account_number (list) or account_number (webhook),
 * the sender in source_* (list) or sender_* (webhook).
 */
export function parseCollection(raw: unknown): PayrepCollection | null {
  const o = obj(raw);
  if (!o) return null;
  const transactionId = collectionKey(o);
  const amount = money(o.amount);
  if (!transactionId || !amount) return null;
  const sender = s(o.sender_account_number, 20) ?? s(o.source_account_number, 20);
  const status = (s(o.status) ?? '').toLowerCase();
  const type = s(o.transaction_type, 20)?.toLowerCase() ?? null;
  // The webhook names the account paid account_number. The list files a collection under our pool
  // account (account__account_number); the customer's account paid is the beneficiary (sandbox, 22 Oct 2026).
  const accountNumber =
    s(o.account_number, 20) ?? (type === 'credit' ? s(o.beneficiary_account_number, 20) : null) ?? s(o.account__account_number, 20);
  return {
    transactionId,
    amount,
    referenceNumber: s(o.reference_number),
    sessionId: s(o.session_id),
    status: o.is_reversed === true ? 'reversed' : status,
    fee: money(o.charges),
    channel: s(o.channel, 50),
    createdAt: s(o.created_at, 40),
    accountNumber,
    transactionType: type,
    payerName: s(o.sender_account_name) ?? s(o.source_account_name),
    payerBankName: s(o.sender_bank_name) ?? s(o.source_bank_name) ?? s(o.bank_name),
    payerAccountMasked: sender ? `${'*'.repeat(Math.max(0, sender.length - 4))}${sender.slice(-4)}` : null,
  };
}
