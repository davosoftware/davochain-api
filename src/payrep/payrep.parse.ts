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

/** One credit, or null when it lacks an id or a readable amount (never guessed). */
export function parseCollection(raw: unknown): PayrepCollection | null {
  const o = obj(raw);
  if (!o) return null;
  const transactionId = s(o.transaction_id) ?? s(o.id);
  const amount = money(o.amount);
  if (!transactionId || !amount) return null;
  const sender = s(o.sender_account_number, 20);
  return {
    transactionId,
    amount,
    referenceNumber: s(o.reference_number),
    sessionId: s(o.session_id),
    status: (s(o.status) ?? '').toLowerCase(),
    fee: money(o.charges),
    channel: s(o.channel, 50),
    createdAt: s(o.created_at, 40),
    accountNumber: s(o.account_number, 20),
    transactionType: s(o.transaction_type, 20)?.toLowerCase() ?? null,
    payerName: s(o.sender_account_name),
    payerBankName: s(o.sender_bank_name) ?? s(o.bank_name),
    payerAccountMasked: sender ? `${'*'.repeat(Math.max(0, sender.length - 4))}${sender.slice(-4)}` : null,
  };
}
