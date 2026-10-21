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
  /** Admin-triggered fee claims. Throttled well under the shared rate limit. */
  FEE_CLAIMS: 'fee-claims',
  /** Push / in-app / email fan-out. */
  NOTIFICATIONS: 'notifications',
  /** Admin alert mail. A silent failure here is the same as no alert. */
  EMAIL: 'email',
  /** Chain list + transfer limit sync from Quidax. */
  SYNC: 'sync',
  /** Naira deposits through Payrep: confirm each payment, then credit it exactly once. */
  NAIRA_DEPOSITS: 'naira-deposits',
  /** Advanced KYC: the paid Dojah checks for one attempt, off the request. */
  KYC_ADVANCED: 'kyc-advanced',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const JOBS = {
  PROVISION_SUBACCOUNT: 'provision-subaccount',
  PROCESS_WEBHOOK: 'process-webhook',
  POLL_ADDRESS: 'poll-address',
  CLAIM_FEE: 'claim-fee',
  SEND_NOTIFICATION: 'send-notification',
  SEND_EMAIL: 'send-email',
  SYNC_NETWORKS: 'sync-networks',
  PROCESS_NAIRA_PAYIN: 'process-naira-payin',
  RUN_ADVANCED: 'run-advanced',
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
