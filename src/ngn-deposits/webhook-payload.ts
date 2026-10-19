export type WebhookKind = 'CHARGE' | 'TRANSFER' | 'OTHER';

export interface ParsedWebhook {
  kind: WebhookKind;
  eventName: 'flutterwave.charge' | 'flutterwave.transfer' | 'flutterwave.other';
  /** A lookup key, nothing more: verify decides everything about the payment. */
  transactionId: string | null;
  /** The webhook's own fields, unverified, kept for support. */
  hint: Record<string, string | null>;
  /** For a TRANSFER: our own reference, to ask the rail about. Nothing else in the body is trusted. */
  transferReference: string | null;
}

const NUMERIC_ID = /^\d{1,19}$/;

function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asText(v: unknown, max = 200): string | null {
  return typeof v === 'string' ? v.slice(0, max) : null;
}

/**
 * Both shapes Flutterwave sends (spec §6.2): the documented v3 envelope
 * { event, data: { id, … } } and the flat legacy body { id, txRef, …,
 * "event.type" } that the sandbox actually sent. Expects parseJsonExact output,
 * so numbers arrive as their exact text and a large id keeps every digit.
 */
export function parseFlutterwaveWebhook(body: unknown): ParsedWebhook {
  const root = asObject(body) ?? {};
  const data = asObject(root.data);
  const source = data ?? root;
  const event = asText(root.event)?.toLowerCase() ?? null;
  const eventType = asText(root['event.type'])?.toUpperCase() ?? null;
  const rawId = asText(source.id, 40);
  const transactionId = rawId && NUMERIC_ID.test(rawId) ? rawId : null;

  const isCharge = event === 'charge.completed' || eventType === 'BANK_TRANSFER_TRANSACTION';
  const isTransfer = event === 'transfer.completed' || eventType === 'TRANSFER';
  const kind: WebhookKind = isCharge && transactionId ? 'CHARGE' : isTransfer ? 'TRANSFER' : 'OTHER';
  const eventName =
    kind === 'CHARGE' ? 'flutterwave.charge' : kind === 'TRANSFER' ? 'flutterwave.transfer' : 'flutterwave.other';

  return {
    kind,
    eventName,
    transactionId: kind === 'OTHER' ? null : transactionId,
    transferReference: kind === 'TRANSFER' ? asText(source.reference, 100) : null,
    hint: {
      event: asText(root.event) ?? asText(root['event.type']),
      id: rawId,
      txRef: asText(source.tx_ref) ?? asText(source.txRef),
      flwRef: asText(source.flw_ref) ?? asText(source.flwRef),
      amount: asText(source.amount),
      currency: asText(source.currency),
      status: asText(source.status),
    },
  };
}
