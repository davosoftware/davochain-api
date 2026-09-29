/**
 * Every email the system can send.
 *
 * The catalogue lives in code and the wording lives in the database. A template
 * exists because something in the API sends it — adding a key here without a
 * caller would put a switch in the admin that does nothing, which is worse than
 * no switch. `sentBy` names that caller so the pairing can be checked by
 * reading, and `EMAIL_TEMPLATE_KEYS` is what the seed and the guard validate
 * against.
 *
 * Bodies are rich HTML and are wrapped in the brand layout at send time. Nobody
 * edits the layout from the admin: one change to it fixes every email at once,
 * and fifteen copies of a header is fifteen chances to be inconsistent.
 */

import { renderMarkdown } from './markdown';

/**
 * The defaults below are WRITTEN in Markdown and STORED as HTML.
 *
 * The editor is rich text and everything downstream expects HTML, but a
 * catalogue of twenty-two hand-written HTML bodies is unreadable and invites
 * a typo in a tag that nobody notices until it reaches an inbox. Authoring in
 * Markdown and converting once, here, keeps the source legible and the output
 * exactly what the editor would have produced.
 */
const html = (markdown: string): string => renderMarkdown(markdown);

export interface EmailTemplateDef {
  key: string;
  label: string;
  /** What causes it to be sent, in a sentence the admin can act on. */
  hint: string;
  group: string;
  /** Placeholders this template may use, beyond the shared ones. */
  variables: string[];
  /** Where in the API it is sent from. Kept honest by the spec. */
  sentBy: string;
  /** True when the code path exists but the rail behind it does not yet. */
  pending?: string;
  subject: string;
  body: string;
}

/** Available to every template, so they are not repeated on each one. */
export const SHARED_VARIABLES = [
  'firstName',
  'lastName',
  'email',
  'companyName',
  'supportEmail',
  'year',
];

const SIGN_OFF = `
Thanks,
The {{companyName}} team`;

/**
 * A one-time code, set out to be read and typed.
 *
 * Written as literal HTML rather than through the Markdown helper because this
 * is the one thing in these emails whose *presentation* is the point: six
 * digits somebody has to copy off a screen, often from a phone, sometimes
 * squinting. Bold body text is not enough. Wide letter-spacing stops 8 and B
 * running together, and a monospace face keeps every digit the same width.
 *
 * An admin can restyle or replace it — it is ordinary content in the editor.
 */
const codeBlock = (placeholder: string) =>
  `<p style="text-align:center;margin:22px 0;">` +
  `<span style="display:inline-block;padding:14px 26px;background:#f1f4f7;border:1px solid #dadee3;` +
  `border-radius:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:30px;` +
  `font-weight:600;letter-spacing:7px;color:#102c58;">{{${placeholder}}}</span></p>`;

export const EMAIL_TEMPLATES: EmailTemplateDef[] = [
  // ── account ───────────────────────────────────────────────
  {
    key: 'user.welcome',
    label: 'Welcome',
    hint: 'Sent once, immediately after somebody registers.',
    group: 'Account',
    variables: [],
    sentBy: 'AuthService.register',
    subject: 'Welcome to {{companyName}}',
    body: html(`Hi {{firstName}},

Your {{companyName}} account is ready.

To start buying and selling, you will need to verify your identity — it takes a
couple of minutes and unlocks trading, deposit addresses and withdrawals.

If you did not create this account, reply to this email and we will close it.
${SIGN_OFF}`),
  },
  {
    key: 'user.suspended',
    label: 'Account suspended',
    hint: 'Sent when an admin suspends the account. The reason they typed is included.',
    group: 'Account',
    variables: ['reason'],
    sentBy: 'UsersAdminService.suspend',
    subject: 'Your {{companyName}} account has been suspended',
    body: html(`Hi {{firstName}},

Your account has been suspended and you will not be able to sign in.

**Reason:** {{reason}}

If you believe this is a mistake, reply to this email or contact
{{supportEmail}} and we will look into it.
${SIGN_OFF}`),
  },
  {
    key: 'user.reinstated',
    label: 'Account reinstated',
    hint: 'Sent when an admin lifts a suspension.',
    group: 'Account',
    variables: [],
    sentBy: 'UsersAdminService.reinstate',
    subject: 'Your {{companyName}} account is active again',
    body: html(`Hi {{firstName}},

Your account has been reinstated and you can sign in as normal.

Thank you for your patience.
${SIGN_OFF}`),
  },
  {
    key: 'user.password_reset',
    label: 'Password reset code',
    hint: 'The six-digit code for Forgot password. The only way back into an account nobody can sign in to.',
    group: 'Account',
    variables: ['code', 'expiresIn'],
    sentBy: 'AuthService.requestPasswordReset',
    subject: 'Your {{companyName}} password reset code',
    body:
      html('Hi {{firstName}},\n\nYour password reset code is:') +
      codeBlock('code') +
      html(`It expires in {{expiresIn}}. Enter it in the app to choose a new password.

If you did not ask to reset your password, ignore this email — nothing has
changed, and nobody can use this code without your inbox.
${SIGN_OFF}`),
  },
  {
    key: 'user.password_changed',
    label: 'Password changed',
    hint: 'Sent after a password changes, by either route. A security notice, not a courtesy.',
    group: 'Account',
    variables: ['changedAt', 'method'],
    sentBy: 'AuthService.changePassword and .resetPassword',
    subject: 'Your {{companyName}} password was changed',
    body: html(`Hi {{firstName}},

The password on your account was changed on {{changedAt}} ({{method}}).
Every device signed in to this account has been signed out.

**If this was not you**, contact {{supportEmail}} straight away — somebody else
may have access to your account.
${SIGN_OFF}`),
  },

  // ── verification ──────────────────────────────────────────
  {
    key: 'kyc.submitted',
    label: 'Verification submitted',
    hint: 'Sent when a user submits their BVN or NIN for review.',
    group: 'Verification',
    variables: [],
    sentBy: 'KycService.submitTier1',
    subject: 'We have your verification details',
    body: html(`Hi {{firstName}},

Thanks — we have received your verification details and they are being
reviewed. You will hear from us as soon as that is done.

You do not need to send anything else in the meantime.
${SIGN_OFF}`),
  },
  {
    key: 'kyc.approved',
    label: 'Verification approved',
    hint: 'Sent when an admin approves a submission. The user must sign in again afterwards.',
    group: 'Verification',
    variables: ['tier'],
    sentBy: 'KycAdminService.approve',
    subject: 'You are verified',
    body: html(`Hi {{firstName}},

Your identity has been verified and your account is now **{{tier}}**. Buying,
selling, swapping and withdrawals are all open to you.

You will need to sign in again for the change to take effect.
${SIGN_OFF}`),
  },
  {
    key: 'kyc.rejected',
    label: 'Verification rejected',
    hint: 'Sent when an admin rejects a submission. Carries the reason they gave.',
    group: 'Verification',
    variables: ['reason'],
    sentBy: 'KycAdminService.reject',
    subject: 'We could not verify your details',
    body: html(`Hi {{firstName}},

We were not able to verify the details you sent.

**Reason:** {{reason}}

You can submit again from the app. If you think this is wrong, contact
{{supportEmail}} and we will take another look.
${SIGN_OFF}`),
  },

  // ── deposits ──────────────────────────────────────────────
  {
    key: 'address.ready',
    label: 'Deposit address ready',
    hint: 'Sent when a coin deposit address finishes generating. It is created asynchronously, so a user who closed the app never sees it otherwise.',
    group: 'Deposits',
    variables: ['assetCode', 'networkLabel', 'address', 'destinationTag'],
    sentBy: 'AddressesService.applyGenerated',
    subject: 'Your {{assetCode}} deposit address is ready',
    body: html(`Hi {{firstName}},

Your **{{assetCode}}** deposit address on {{networkLabel}} is ready:

\`{{address}}\`

Open the app to copy it — reading an address off an email and typing it by hand
is how coins get sent to the wrong place.

Only send **{{assetCode}}** on **{{networkLabel}}** to this address. Anything
else is lost on the chain and cannot be recovered by us or by anyone.
${SIGN_OFF}`),
  },
  {
    key: 'deposit.credited',
    label: 'Crypto deposit credited',
    hint: 'Sent when a coin deposit clears and lands in the wallet.',
    group: 'Deposits',
    variables: ['amount', 'assetCode', 'transactionId'],
    sentBy: 'DepositsService (deposit.successful webhook)',
    subject: '{{amount}} {{assetCode}} added to your wallet',
    body: html(`Hi {{firstName}},

Your deposit of **{{amount}} {{assetCode}}** has cleared and is available in
your wallet now.

Reference: {{transactionId}}
${SIGN_OFF}`),
  },
  {
    key: 'deposit.on_hold',
    label: 'Deposit under review',
    hint: 'Sent when a deposit is held for a routine check.',
    group: 'Deposits',
    variables: ['amount', 'assetCode', 'transactionId'],
    sentBy: 'DepositsService (deposit.on_hold webhook)',
    subject: 'Your {{assetCode}} deposit is being reviewed',
    body: html(`Hi {{firstName}},

Your deposit of **{{amount}} {{assetCode}}** is going through a routine check.

Your funds are safe. We will email you again as soon as the review is finished —
there is nothing you need to do.

Reference: {{transactionId}}
${SIGN_OFF}`),
  },
  {
    key: 'deposit.failed',
    label: 'Deposit failed',
    hint: 'Sent when a deposit is rejected and cannot be credited.',
    group: 'Deposits',
    variables: ['amount', 'assetCode', 'reason', 'transactionId'],
    sentBy: 'DepositsService (deposit.rejected / failed_aml webhook)',
    subject: 'Your {{assetCode}} deposit could not be completed',
    body: html(`Hi {{firstName}},

We were not able to complete your deposit of **{{amount}} {{assetCode}}**.

**Reason:** {{reason}}

Contact {{supportEmail}} if you believe this is an error and we will
investigate.

Reference: {{transactionId}}
${SIGN_OFF}`),
  },
  {
    key: 'ngn.deposit.credited',
    label: 'Naira deposit credited',
    hint: 'Sent when a bank transfer tops up a naira balance.',
    group: 'Deposits',
    variables: ['amount', 'transactionId'],
    sentBy: 'Naira funding provider',
    pending: 'No naira funding provider is connected yet, so nothing sends this.',
    subject: '₦{{amount}} added to your balance',
    body: html(`Hi {{firstName}},

We have received **₦{{amount}}** and added it to your naira balance.

Reference: {{transactionId}}
${SIGN_OFF}`),
  },

  // ── withdrawals ───────────────────────────────────────────
  {
    key: 'withdrawal.submitted',
    label: 'Withdrawal requested',
    hint: 'Sent the moment a withdrawal is requested, before it leaves. This is how somebody notices a withdrawal they did not make while it can still be stopped.',
    group: 'Withdrawals',
    variables: ['amount', 'assetCode', 'address', 'networkLabel', 'transactionId'],
    sentBy: 'WithdrawalsService.withdrawCrypto',
    subject: 'Withdrawal requested: {{amount}} {{assetCode}}',
    body: html(`Hi {{firstName}},

A withdrawal of **{{amount}} {{assetCode}}** has been requested from your
account, to this address on {{networkLabel}}:

\`{{address}}\`

We will email you again when it leaves.

**If you did not request this**, contact {{supportEmail}} immediately and change
your password. A withdrawal that has not been sent yet can sometimes be stopped;
once it is on the chain it cannot.

Reference: {{transactionId}}
${SIGN_OFF}`),
  },
  {
    key: 'withdrawal.sent',
    label: 'Crypto withdrawal sent',
    hint: 'Sent when a coin withdrawal leaves the platform.',
    group: 'Withdrawals',
    variables: ['amount', 'assetCode', 'txHash', 'transactionId'],
    sentBy: 'SettlementService (withdrawal.successful webhook)',
    subject: '{{amount}} {{assetCode}} is on its way',
    body: html(`Hi {{firstName}},

Your withdrawal of **{{amount}} {{assetCode}}** has been sent.

Transaction hash: \`{{txHash}}\`

You can track it on a block explorer with that hash. How long it takes to
arrive depends on the network, not on us.

Reference: {{transactionId}}
${SIGN_OFF}`),
  },
  {
    key: 'withdrawal.rejected',
    label: 'Crypto withdrawal rejected',
    hint: 'Sent when a withdrawal is refused. The amount goes back to the wallet.',
    group: 'Withdrawals',
    variables: ['amount', 'assetCode', 'reason', 'transactionId'],
    sentBy: 'SettlementService (withdrawal.rejected webhook)',
    subject: 'Your {{assetCode}} withdrawal was not sent',
    body: html(`Hi {{firstName}},

Your withdrawal of **{{amount}} {{assetCode}}** could not be sent, and the
amount has been returned to your wallet.

**Reason:** {{reason}}

Reference: {{transactionId}}
${SIGN_OFF}`),
  },
  {
    key: 'ngn.withdrawal.sent',
    label: 'Naira withdrawal sent',
    hint: 'Sent when a naira cash-out is paid to a bank account.',
    group: 'Withdrawals',
    variables: ['amount', 'fee', 'bankName', 'accountNumber', 'transactionId'],
    sentBy: 'Naira payout provider',
    pending: 'No naira payout provider is connected yet, so nothing sends this.',
    subject: '₦{{amount}} sent to your bank',
    body: html(`Hi {{firstName}},

**₦{{amount}}** is on its way to {{bankName}} ({{accountNumber}}).

A fee of ₦{{fee}} was charged, so ₦{{amount}} reaches your bank.

Reference: {{transactionId}}
${SIGN_OFF}`),
  },

  // ── trading ───────────────────────────────────────────────
  {
    key: 'trade.buy.completed',
    label: 'Crypto buy',
    hint: 'Sent when a purchase with naira completes.',
    group: 'Trading',
    variables: ['fromAmount', 'toAmount', 'toAsset', 'rate', 'transactionId'],
    sentBy: 'TradesService / SettlementService on a BUY',
    subject: 'You bought {{toAmount}} {{toAsset}}',
    body: html(`Hi {{firstName}},

Your purchase is complete.

- **Spent:** ₦{{fromAmount}}
- **Received:** {{toAmount}} {{toAsset}}
- **Rate:** ₦{{rate}} per unit

Reference: {{transactionId}}
${SIGN_OFF}`),
  },
  {
    key: 'trade.sell.completed',
    label: 'Crypto sell',
    hint: 'Sent when a sale to naira completes.',
    group: 'Trading',
    variables: ['fromAmount', 'fromAsset', 'toAmount', 'rate', 'transactionId'],
    sentBy: 'TradesService / SettlementService on a SELL',
    subject: 'You sold {{fromAmount}} {{fromAsset}}',
    body: html(`Hi {{firstName}},

Your sale is complete.

- **Sold:** {{fromAmount}} {{fromAsset}}
- **Received:** ₦{{toAmount}}
- **Rate:** ₦{{rate}} per unit

Reference: {{transactionId}}
${SIGN_OFF}`),
  },
  {
    key: 'trade.swap.completed',
    label: 'Coin swap',
    hint: 'Sent when a coin-to-coin swap settles.',
    group: 'Trading',
    variables: ['fromAmount', 'fromAsset', 'toAmount', 'toAsset', 'transactionId'],
    sentBy: 'SettlementService on a SWAP',
    subject: 'Your swap to {{toAsset}} is complete',
    body: html(`Hi {{firstName}},

Your swap has settled.

- **From:** {{fromAmount}} {{fromAsset}}
- **To:** {{toAmount}} {{toAsset}}

Reference: {{transactionId}}
${SIGN_OFF}`),
  },
  {
    key: 'trade.failed',
    label: 'Trade failed',
    hint: 'Sent when a trade could not complete. Nothing is deducted.',
    group: 'Trading',
    variables: ['reason', 'transactionId'],
    sentBy: 'SettlementService.reverse',
    subject: 'Your trade could not be completed',
    body: html(`Hi {{firstName}},

Your trade did not go through, and **nothing was deducted from your balance**.

**Reason:** {{reason}}

You are welcome to try again — the price will be quoted fresh.

Reference: {{transactionId}}
${SIGN_OFF}`),
  },

  // ── admin ─────────────────────────────────────────────────
  {
    key: 'admin.invited',
    label: 'Admin invitation',
    hint: 'Sent when an owner adds someone to the team. Carries a single-use link to set a password — never a password.',
    group: 'Admin team',
    variables: ['inviteUrl', 'role', 'invitedBy', 'expiresIn'],
    sentBy: 'AdminsService.createAdmin',
    subject: 'You have been added to the {{companyName}} dashboard',
    body: html(`Hi {{firstName}},

{{invitedBy}} has added you to the {{companyName}} admin dashboard as
**{{role}}**.

Set your password to get in:

[Set your password]({{inviteUrl}})

The link works once and expires in {{expiresIn}}. If it runs out, use **Forgot
password** on the sign-in page.

If you were not expecting this, ignore it and tell {{supportEmail}}.
${SIGN_OFF}`),
  },
  {
    key: 'admin.password_reset',
    label: 'Admin password reset code',
    hint: 'The six-digit code for Forgot password. Also copied to every owner when a sub-admin resets.',
    group: 'Admin team',
    variables: ['code', 'expiresIn'],
    sentBy: 'OtpService.requestReset',
    subject: 'Your {{companyName}} admin reset code',
    body:
      html('Hi {{firstName}},\n\nYour password reset code is:') +
      codeBlock('code') +
      html(`It expires in {{expiresIn}}. If you did not ask for it, ignore this email — your
password has not changed.
${SIGN_OFF}`),
  },
  {
    key: 'admin.password_reset_notice',
    label: 'Admin reset — owner copy',
    hint: 'Copied to every owner when a SUB-ADMIN resets their password, so a reset on an account that can move money is seen rather than read about later.',
    group: 'Admin team',
    variables: ['code', 'expiresIn', 'adminName', 'adminEmail'],
    sentBy: 'OtpService.requestReset',
    subject: 'Password reset requested for {{adminEmail}}',
    body: html(`Hi {{firstName}},

**{{adminName}}** ({{adminEmail}}) asked to reset their admin password.

Their code is **{{code}}**, valid for {{expiresIn}}.

You are copied because they are a sub-admin. If they did not ask for this,
deactivate the account from **Settings → Team** now.
${SIGN_OFF}`),
  },
  {
    key: 'admin.password_changed',
    label: 'Admin password changed',
    hint: 'Security notice after an admin password changes, by either route.',
    group: 'Admin team',
    variables: ['changedAt', 'method'],
    sentBy: 'AdminsService.applyNewPassword',
    subject: 'Your {{companyName}} admin password was changed',
    body: html(`Hi {{firstName}},

The password on your admin account was changed on {{changedAt}} ({{method}}).
Every other session has been signed out.

**If this was not you**, contact {{supportEmail}} immediately — an admin account
can move money.
${SIGN_OFF}`),
  },
];

/**
 * Stand-in values for the preview.
 *
 * One map covering every placeholder in the catalogue rather than samples per
 * template: a preview only has to look plausible, and a second list to keep in
 * step with the first is a second list to forget. Anything missing here shows
 * as its own `{{placeholder}}`, which is the honest result.
 */
export const SAMPLE_VALUES: Record<string, string> = {
  firstName: 'Ada',
  lastName: 'Okafor',
  email: 'ada@example.com',
  amount: '0.05000000',
  assetCode: 'BTC',
  fromAmount: '97,150.00',
  fromAsset: 'NGN',
  toAmount: '0.00067342',
  toAsset: 'BTC',
  rate: '1,450.80',
  fee: '100.00',
  address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
  bankName: 'GTBank',
  accountNumber: '••••4471',
  reason: 'The details did not match the records held by the provider',
  tier: 'TIER_1',
  transactionId: '9b4e20f9-cf03-4481-995d-84676e255e6c',
  changedAt: '6 September 2026 at 14:20 WAT',
  method: 'with the current password',
  code: '482913',
  networkLabel: 'Bitcoin Network',
  destinationTag: '—',
  expiresIn: '10 minutes',
  inviteUrl: 'https://admin.davochain.com/invite/sample-token',
  role: 'Sub-admin',
  invitedBy: 'Chidi Balogun',
};

export const EMAIL_TEMPLATE_KEYS: string[] = EMAIL_TEMPLATES.map((t) => t.key);

const BY_KEY = new Map(EMAIL_TEMPLATES.map((t) => [t.key, t]));

export function emailTemplate(key: string): EmailTemplateDef | undefined {
  return BY_KEY.get(key);
}

export function isEmailTemplateKey(key: string): boolean {
  return BY_KEY.has(key);
}

/** Every placeholder a template is allowed to use. */
export function allowedVariables(key: string): string[] {
  const def = BY_KEY.get(key);
  return def ? [...SHARED_VARIABLES, ...def.variables] : [...SHARED_VARIABLES];
}
