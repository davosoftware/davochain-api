/**
 * Separate queues, deliberately. A backlog in one must never delay another —
 * a fee-claim run of 400 receivables cannot be allowed to hold up a deposit
 * credit, and address polling must not sit behind reconciliation.
 */
export const QUEUES = {
  /** Quidax sub-account creation. A signup must not fail because upstream did. */
  PROVISIONING: 'provisioning',
  /** Inbound webhook processing. The HTTP handler only stores and returns 200. */
  WEBHOOKS: 'webhooks',
  /** Address generation is async; poll as a backstop for a lost webhook. */
  ADDRESSES: 'addresses',
  /** Multi-step trade settlement and its compensating reversals. */
  SETTLEMENT: 'settlement',
  /** Admin-triggered fee claims. Throttled well under the shared rate limit. */
  FEE_CLAIMS: 'fee-claims',
  /** Push / in-app / email fan-out. */
  NOTIFICATIONS: 'notifications',
  /** Admin alert mail. A silent failure here is the same as no alert. */
  EMAIL: 'email',
  /** Invariant checks, webhook gap sweeps, stuck-leg resolution. */
  RECONCILIATION: 'reconciliation',
  /** Chain list + transfer limit sync from Quidax. */
  SYNC: 'sync',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const JOBS = {
  PROVISION_SUBACCOUNT: 'provision-subaccount',
  PROCESS_WEBHOOK: 'process-webhook',
  POLL_ADDRESS: 'poll-address',
  RESOLVE_LEG: 'resolve-leg',
  REVERSE_TRANSACTION: 'reverse-transaction',
  CLAIM_FEE: 'claim-fee',
  SEND_NOTIFICATION: 'send-notification',
  SEND_EMAIL: 'send-email',
  CHECK_INVARIANTS: 'check-invariants',
  SWEEP_WEBHOOK_GAPS: 'sweep-webhook-gaps',
  SYNC_NETWORKS: 'sync-networks',
  DAILY_DIGEST: 'daily-digest',
} as const;

/** Retry with backoff. Anything touching money keeps trying rather than dropping. */
export const DEFAULT_JOB_OPTS = {
  attempts: 8,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 86_400, count: 5_000 },
  removeOnFail: false, // a failed money job is evidence; keep it
};

/**
 * Build a BullMQ-safe job id.
 *
 * BullMQ REJECTS a custom id containing ":" — it uses the colon as its own key
 * separator, and `queue.add()` throws "Custom Id cannot contain :". The throw
 * happens at enqueue time, so a caller that does not catch it loses the job and
 * may fail the surrounding request. Always build ids through this.
 */
export function jobId(...parts: Array<string | number>): string {
  return parts
    .map((p) => String(p).replace(/[^a-zA-Z0-9_-]+/g, '-'))
    .filter(Boolean)
    .join('-');
}
