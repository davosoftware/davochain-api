/**
 * What a sub-admin can be given.
 *
 * One key per thing a person actually does, split into seeing and doing
 * wherever the doing moves money or changes what users experience. Somebody
 * who reconciles the books every morning needs to read the inventory desk; they
 * do not need to be able to reprice the platform.
 *
 * An OWNER is not checked against this list at all. Storing an owner's
 * permissions would mean a stale list could lock them out of their own
 * dashboard, and there would be nobody left who could grant them back.
 */
export const PERMISSION_GROUPS = [
  {
    label: 'Watch',
    permissions: [
      { key: 'overview.view', label: 'Overview', hint: 'The morning dashboard' },
      { key: 'inventory.view', label: 'See the inventory desk', hint: 'Holdings, cover, alerts' },
      {
        key: 'inventory.manage',
        label: 'Set targets and record refills',
        hint: 'Changes what the desk considers healthy',
      },
      { key: 'reconciliation.view', label: 'See reconciliation', hint: 'The ledger invariants' },
    ],
  },
  {
    label: 'Money',
    permissions: [
      { key: 'fees.view', label: 'See both fee ladders', hint: 'Rate fee and swap fee' },
      {
        key: 'fees.manage',
        label: 'Change the fee ladders',
        hint: 'Reprices every trade from the moment it is saved',
      },
      { key: 'claims.view', label: 'See claimable fees' },
      { key: 'claims.manage', label: 'Claim fees', hint: 'Moves value to the main account' },
      { key: 'transactions.view', label: 'See transactions' },
      {
        key: 'transactions.approve',
        label: 'Release or reject held deposits',
        hint: 'Releasing credits a naira deposit that arrived over the depositor’s tier limit. It moves real money into a balance.',
      },
      {
        key: 'earnings.view',
        label: 'See the earnings manager',
        hint: 'Every fee the platform has charged, and which user paid it',
      },
      { key: 'referrals.view', label: 'See referrals and rewards' },
      {
        key: 'referrals.manage',
        label: 'Set the referral offer',
        hint: 'What each side is paid and what unlocks it. Changing it never reprices a reward already promised.',
      },
      { key: 'giftcards.view', label: 'See gift cards and trades' },
      {
        key: 'giftcards.manage',
        label: 'Set up gift cards',
        hint: 'Brands, categories, card types and the rates users are quoted',
      },
      {
        key: 'giftcards.review',
        label: 'Approve or reject traded cards',
        hint: 'Approving credits real naira to somebody’s balance',
      },
    ],
  },
  {
    label: 'People',
    permissions: [
      { key: 'users.view', label: 'See users and their balances' },
      { key: 'users.manage', label: 'Suspend and reinstate users' },
      { key: 'kyc.view', label: 'See KYC submissions' },
      { key: 'kyc.review', label: 'Approve or reject KYC', hint: 'Unlocks trading for a person' },
      { key: 'notifications.send', label: 'Send notifications' },
    ],
  },
  {
    label: 'Content',
    permissions: [
      {
        key: 'content.view',
        label: 'See the CMS',
        hint: 'Pages, FAQs and email wording, read-only',
      },
      {
        key: 'content.manage',
        label: 'Edit pages and FAQs',
        hint: 'Publishes straight to the website and the apps — there is no review step',
      },
      {
        key: 'content.emails',
        label: 'Edit email templates',
        hint: 'Changes the wording of what every user receives, and can switch an email off entirely',
      },
    ],
  },
  {
    label: 'Oversight',
    permissions: [
      { key: 'audit.view', label: 'See the audit log', hint: 'Every admin action, by whom' },
      {
        key: 'settings.manage',
        label: 'Edit site settings',
        hint: 'Contact details, store links and social handles shown on the public website',
      },
      {
        key: 'credentials.manage',
        label: 'Manage partner API keys',
        hint: 'The Quidax key can move money. Owners only, whatever else is granted.',
      },
      {
        key: 'kyc.limits',
        label: 'Set KYC limits',
        hint: 'How much naira each tier may move in a day',
      },
      {
        key: 'team.manage',
        label: 'Manage the team',
        hint: 'Add and deactivate sub-admins. Only an owner can grant permissions or make another owner.',
      },
    ],
  },
] as const;

export type Permission = (typeof PERMISSION_GROUPS)[number]['permissions'][number]['key'];

export const ALL_PERMISSIONS: string[] = PERMISSION_GROUPS.flatMap((g) =>
  g.permissions.map((p) => p.key),
);

const PERMISSION_SET = new Set(ALL_PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

/**
 * Sensible starting point for a new sub-admin: everything read-only, nothing
 * that changes state. An owner widens it from there deliberately, rather than
 * narrowing a default that was too generous.
 */
export const DEFAULT_SUB_ADMIN_PERMISSIONS: string[] = [
  'overview.view',
  'inventory.view',
  'reconciliation.view',
  'fees.view',
  'transactions.view',
  'users.view',
  'kyc.view',
];
