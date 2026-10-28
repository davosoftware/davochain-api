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
import type { FrameDef } from './email-frame';

/**
 * The defaults below are WRITTEN in Markdown and STORED as HTML.
 *
 * The editor is rich text and everything downstream expects HTML, but a
 * catalogue of twenty-two hand-written HTML bodies is unreadable and invites
 * a typo in a tag that nobody notices until it reaches an inbox. Authoring in
 * Markdown and converting once, here, keeps the source legible and the output
 * exactly what the editor would have produced.
 */
const SIGN_OFF_MARK = 'SIGNOFFMARKER';
const html = (markdown: string): string =>
  // Markdown has no line break inside a paragraph, so the sign-off's two lines are put in after.
  renderMarkdown(markdown).replace(`<p>${SIGN_OFF_MARK}</p>`, '<p>Thanks,<br />The {{companyName}} team</p>');

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
  /** The coloured panel, receipt list and button around the words (design approved 22 Oct 2026). Not editable from the dashboard. */
  frame: FrameDef;
  /** Sample values for the preview where the shared ones would read wrong (naira amounts, say). */
  samples?: Record<string, string>;
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

/** "Thanks, / The DavoChain team", on two lines. Receipts end with their list instead. */
const SIGN_OFF = `
${SIGN_OFF_MARK}`;

/** The button on emails that ask someone to act in the app. */
const NO_BUTTON = false as const;

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
    frame: { panel: { kind: 'done', label: 'Welcome', value: 'Your account is ready', sub: 'Hi {{firstName}}, glad to have you' } },
    body: html(`Hi {{firstName}},

Welcome to {{companyName}}. You can buy, sell and swap crypto, sell gift cards
and move naira, all in one app.

**Two quick steps to get going:**

1. Confirm your email with the code we just sent you.
2. Verify your identity in the app. It takes a couple of minutes.

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
    frame: { panel: { kind: 'problem', label: 'Account update', value: 'Your account is suspended' }, button: NO_BUTTON },
    body: html(`Hi {{firstName}},

Your account has been suspended, so you can't sign in for now.

**Reason:** {{reason}}

If you think this is a mistake, reply to this email or write to
{{supportEmail}} and we will look into it.
${SIGN_OFF}`),
  },
  {
    key: 'user.closed',
    label: 'Account closed',
    hint: 'Sent to the customer when an owner closes their account. Sent to their real address, before it is released.',
    group: 'Account',
    variables: [],
    sentBy: 'AccountClosureService.close',
    subject: 'Your {{companyName}} account has been closed',
    frame: { panel: { kind: 'problem', label: 'Account update', value: 'Your account is closed' }, button: NO_BUTTON },
    body: html(`Hi {{firstName}},

Your {{companyName}} account has been closed, so you can no longer sign in to it.
Your account held no money when it was closed.

You are welcome to create a new account with the same email address and phone
number at any time. You will need to verify your identity again.

If you did not ask for this, reply to this email or write to {{supportEmail}}.
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
    frame: { panel: { kind: 'done', label: 'Account update', value: 'Your account is active again' } },
    body: html(`Hi {{firstName}},

Good news: your account is active again and you can sign in as normal.

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
    frame: { panel: { kind: 'code', label: 'Password reset code', value: '{{code}}', sub: 'Expires in {{expiresIn}}' }, button: NO_BUTTON },
    body: html(`Hi {{firstName}},

Enter the code above in the app to choose a new password.

If you didn't ask to reset your password, ignore this email. Nothing has
changed, and nobody can use this code without access to your inbox.
${SIGN_OFF}`),
  },
  {
    key: 'user.email_verify',
    label: 'Email confirmation code',
    hint: 'The six-digit code that confirms a new customer owns their email address. Needed before any deposit, withdrawal, trade or verification.',
    group: 'Account',
    variables: ['code', 'expiresIn'],
    sentBy: 'AuthService.sendEmailCode',
    subject: 'Your {{companyName}} email code',
    frame: { panel: { kind: 'code', label: 'Your code', value: '{{code}}', sub: 'Expires in {{expiresIn}}' }, button: NO_BUTTON },
    body: html(`Hi {{firstName}},

Enter the code above in the app to confirm your email address. Once it's
confirmed, deposits, trading and withdrawals open straight away.

Didn't sign up for {{companyName}}? Ignore this email.
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
    frame: { panel: { kind: 'security', label: 'Security notice', value: 'Your password was changed', sub: '{{changedAt}}' } },
    body: html(`Hi {{firstName}},

The password on your account was changed ({{method}}). For your safety,
every device signed in to your account has been signed out.

**Wasn't you?** Contact {{supportEmail}} straight away: someone else may have
access to your account.
${SIGN_OFF}`),
  },

  {
    key: 'destination.added',
    label: 'Withdrawal destination added',
    hint: 'Sent when a bank account or crypto address is saved for withdrawals. A security notice.',
    group: 'Account',
    variables: ['destination'],
    sentBy: 'SavedDestinationsService.addBank and .addCrypto',
    subject: 'A new withdrawal destination was added to your {{companyName}} account',
    frame: { panel: { kind: 'security', label: 'Security notice', value: 'New withdrawal destination', sub: '{{destination}}' } },
    body: html(`Hi {{firstName}},

A new place to withdraw to was saved on your account: **{{destination}}**.

**Wasn't you?** Contact {{supportEmail}} straight away and change your
password: someone else may have access to your account.
${SIGN_OFF}`),
  },
  {
    key: 'destination.removed',
    label: 'Withdrawal destination removed by our team',
    hint: 'Sent when an admin removes one of the saved withdrawal destinations of a customer.',
    group: 'Account',
    variables: ['destination', 'reason'],
    sentBy: 'Admin: remove a saved destination',
    subject: 'A saved withdrawal destination was removed',
    frame: { panel: { kind: 'security', label: 'Account update', value: 'Withdrawal destination removed', sub: '{{destination}}' } },
    body: html(`Hi {{firstName}},

Our team removed a saved withdrawal destination from your account:
**{{destination}}**.

**Reason:** {{reason}}

Questions? Write to {{supportEmail}}.
${SIGN_OFF}`),
  },

  // ── verification ──────────────────────────────────────────
  {
    key: 'kyc.submitted',
    label: 'Verification submitted',
    hint: 'Sent when Basic verification needs a person to review it.',
    group: 'Verification',
    variables: [],
    sentBy: 'BasicVerificationService.submit',
    subject: 'We have your verification details',
    frame: { panel: { kind: 'progress', label: 'Verification', value: 'We’re reviewing your details' } },
    body: html(`Hi {{firstName}},

Thanks, we have your verification details. A member of our team is reviewing
them, and we'll email you as soon as it's done.

You don't need to send anything else.
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
    frame: { panel: { kind: 'done', label: 'Verification', value: 'You’re verified' } },
    body: html(`Hi {{firstName}},

Your identity has been verified. Buying, selling, swapping and withdrawals are
now open to you, up to your new limits.

Sign in again in the app for the change to take effect.
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
    frame: { panel: { kind: 'problem', label: 'Verification', value: 'We couldn’t verify you yet' } },
    body: html(`Hi {{firstName}},

We weren't able to verify the details you sent.

**Reason:** {{reason}}

You can try again from the app. If you think this is wrong, write to
{{supportEmail}} and we'll take another look.
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
    frame: {
      panel: { kind: 'done', label: 'Deposit address ready', value: '{{assetCode}}', sub: 'on {{networkLabel}}' },
      details: [['Network', '{{networkLabel}}'], ['Address', '{{address}}'], ['Destination tag', '{{destinationTag}}']],
      status: false,
    },
    body: html(`Hi {{firstName}},

Your **{{assetCode}}** deposit address is ready. Copy it from the app rather
than from this email: a single wrong character sends coins to the wrong place.

**Only send {{assetCode}} on {{networkLabel}}** to this address. Anything else is
lost and can't be recovered, by us or by anyone.`),
  },
  {
    key: 'deposit.credited',
    label: 'Crypto deposit credited',
    hint: 'Sent when a coin deposit clears and lands in the wallet.',
    group: 'Deposits',
    variables: ['amount', 'assetCode', 'transactionId'],
    sentBy: 'DepositsService (deposit.successful webhook)',
    subject: '{{amount}} {{assetCode}} added to your wallet',
    frame: {
      panel: { kind: 'done', label: 'Deposit received', value: '{{amount}} {{assetCode}}', sub: 'added to your wallet' },
      details: [['Amount', '{{amount}} {{assetCode}}'], ['Date', '{{date}}'], ['Reference', '{{transactionId}}']],
    },
    body: html(`Hi {{firstName}},

Your deposit has cleared and is in your wallet now.`),
  },
  {
    key: 'deposit.on_hold',
    label: 'Deposit under review',
    hint: 'Sent when a deposit is held for a routine check.',
    group: 'Deposits',
    variables: ['amount', 'assetCode', 'transactionId'],
    sentBy: 'DepositsService (deposit.on_hold webhook)',
    subject: 'Your {{assetCode}} deposit is being reviewed',
    frame: {
      panel: { kind: 'progress', label: 'Deposit under review', value: '{{amount}} {{assetCode}}', sub: 'a routine check' },
      details: [['Amount', '{{amount}} {{assetCode}}'], ['Date', '{{date}}'], ['Reference', '{{transactionId}}']],
    },
    body: html(`Hi {{firstName}},

Your deposit is going through a routine check. Your money is safe, and there's
nothing you need to do. We'll email you as soon as the review is finished.`),
  },
  {
    key: 'deposit.failed',
    label: 'Deposit failed',
    hint: 'Sent when a deposit is rejected and cannot be credited.',
    group: 'Deposits',
    variables: ['amount', 'assetCode', 'reason', 'transactionId'],
    sentBy: 'DepositsService (deposit.rejected / failed_aml webhook)',
    subject: 'Your {{assetCode}} deposit could not be completed',
    frame: {
      panel: { kind: 'problem', label: 'Deposit not completed', value: '{{amount}} {{assetCode}}' },
      details: [['Amount', '{{amount}} {{assetCode}}'], ['Reason', '{{reason}}'], ['Date', '{{date}}'], ['Reference', '{{transactionId}}']],
    },
    body: html(`Hi {{firstName}},

We weren't able to complete this deposit. The reason is below.

If you think this is a mistake, write to {{supportEmail}} with the reference
and we'll look into it.`),
  },
  {
    key: 'ngn.deposit.credited',
    samples: { amount: '25000.00' },
    label: 'Naira deposit credited',
    hint: 'Sent when a bank transfer tops up a naira balance.',
    group: 'Deposits',
    variables: ['amount', 'transactionId'],
    sentBy: 'PayInService (Payrep deposit credited), AdminTransactionsService.release',
    subject: '₦{{amount}} added to your balance',
    frame: {
      panel: { kind: 'done', label: 'Deposit received', value: '₦{{amount}}', sub: 'added to your naira balance' },
      details: [['Amount', '₦{{amount}}'], ['Method', 'Bank transfer'], ['Date', '{{date}}'], ['Reference', '{{transactionId}}']],
    },
    body: html(`Hi {{firstName}},

Your bank transfer has arrived and is in your naira balance now.`),
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
    frame: {
      panel: { kind: 'progress', label: 'Withdrawal requested', value: '{{amount}} {{assetCode}}', sub: 'on {{networkLabel}}' },
      details: [['Amount', '{{amount}} {{assetCode}}'], ['Network', '{{networkLabel}}'], ['Address', '{{address}}'], ['Date', '{{date}}'], ['Reference', '{{transactionId}}']],
    },
    body: html(`Hi {{firstName}},

We've received your withdrawal request and will email you again when it leaves.

**Didn't request this?** Contact {{supportEmail}} immediately and change your
password. A withdrawal that hasn't been sent can sometimes be stopped; once it's
on the blockchain it can't.`),
  },
  {
    key: 'withdrawal.sent',
    label: 'Crypto withdrawal sent',
    hint: 'Sent when a coin withdrawal leaves the platform.',
    group: 'Withdrawals',
    variables: ['amount', 'assetCode', 'txHash', 'transactionId'],
    sentBy: 'SettlementService (withdrawal.successful webhook)',
    subject: '{{amount}} {{assetCode}} is on its way',
    frame: {
      panel: { kind: 'done', label: 'Withdrawal sent', value: '{{amount}} {{assetCode}}', sub: 'on its way' },
      details: [['Amount', '{{amount}} {{assetCode}}'], ['Transaction hash', '{{txHash}}'], ['Date', '{{date}}'], ['Reference', '{{transactionId}}']],
    },
    body: html(`Hi {{firstName}},

Your withdrawal has left {{companyName}}. You can follow it on a block explorer
with the transaction hash below. How long it takes to arrive depends on the
network.`),
  },
  {
    key: 'withdrawal.rejected',
    label: 'Crypto withdrawal rejected',
    hint: 'Sent when a withdrawal is refused. The amount goes back to the wallet.',
    group: 'Withdrawals',
    variables: ['amount', 'assetCode', 'reason', 'transactionId'],
    sentBy: 'SettlementService (withdrawal.rejected webhook)',
    subject: 'Your {{assetCode}} withdrawal was not sent',
    frame: {
      panel: { kind: 'problem', label: 'Withdrawal not sent', value: '{{amount}} {{assetCode}}', sub: 'returned to your wallet' },
      details: [['Amount', '{{amount}} {{assetCode}}'], ['Reason', '{{reason}}'], ['Date', '{{date}}'], ['Reference', '{{transactionId}}']],
    },
    body: html(`Hi {{firstName}},

Your withdrawal couldn't be sent, so the full amount is back in your wallet.
The reason is below.`),
  },
  {
    key: 'ngn.withdrawal.submitted',
    samples: { amount: '25000.00', fee: '50.00' },
    label: 'Naira withdrawal requested',
    hint: 'Sent when a naira bank payout is requested, before the provider processes it.',
    group: 'Withdrawals',
    variables: ['amount', 'fee', 'bankName', 'accountNumber', 'transactionId'],
    sentBy: 'WithdrawalsService.withdrawNgn',
    subject: 'Naira withdrawal requested: ₦{{amount}}',
    frame: {
      panel: { kind: 'progress', label: 'Withdrawal on its way', value: '₦{{amount}}', sub: 'to {{bankName}} {{accountNumber}}' },
      details: [['Amount', '₦{{amount}}'], ['Fee', '₦{{fee}}'], ['Bank', '{{bankName}}'], ['Account', '{{accountNumber}}'], ['Date', '{{date}}'], ['Reference', '{{transactionId}}']],
    },
    body: html(`Hi {{firstName}},

We're sending your naira to your bank. We'll email you again when it's paid.

**Didn't request this?** Contact {{supportEmail}} immediately.`),
  },
  {
    key: 'ngn.withdrawal.sent',
    samples: { amount: '25000.00', fee: '50.00' },
    label: 'Naira withdrawal sent',
    hint: 'Sent when a naira cash-out is paid to a bank account.',
    group: 'Withdrawals',
    variables: ['amount', 'fee', 'bankName', 'accountNumber', 'transactionId'],
    sentBy: 'SettlementService (withdraw.successful webhook)',
    subject: '₦{{amount}} sent to your bank',
    frame: {
      panel: { kind: 'done', label: 'Withdrawal paid', value: '₦{{amount}}', sub: 'to {{bankName}} {{accountNumber}}' },
      details: [['Amount', '₦{{amount}}'], ['Fee', '₦{{fee}}'], ['Bank', '{{bankName}}'], ['Account', '{{accountNumber}}'], ['Date', '{{date}}'], ['Reference', '{{transactionId}}']],
    },
    body: html(`Hi {{firstName}},

Your withdrawal has been paid to your bank. Most banks show it within minutes.`),
  },
  {
    key: 'ngn.withdrawal.rejected',
    samples: { amount: '25000.00' },
    label: 'Naira withdrawal rejected',
    hint: 'Sent when a bank payout is rejected and the locked balance is returned.',
    group: 'Withdrawals',
    variables: ['amount', 'bankName', 'accountNumber', 'reason', 'transactionId'],
    sentBy: 'SettlementService (withdraw.rejected webhook)',
    subject: 'Your naira withdrawal was not paid',
    frame: {
      panel: { kind: 'problem', label: 'Withdrawal not paid', value: '₦{{amount}}', sub: 'returned to your naira balance' },
      details: [['Amount', '₦{{amount}}'], ['Bank', '{{bankName}}'], ['Account', '{{accountNumber}}'], ['Reason', '{{reason}}'], ['Date', '{{date}}'], ['Reference', '{{transactionId}}']],
    },
    body: html(`Hi {{firstName}},

Your withdrawal couldn't be paid, so the full amount is back in your naira
balance. The reason is below.`),
  },

  // ── trading ───────────────────────────────────────────────
  {
    key: 'trade.buy.completed',
    samples: { rate: '144265000.00' },
    label: 'Crypto buy',
    hint: 'Sent when a purchase with naira completes.',
    group: 'Trading',
    variables: ['fromAmount', 'toAmount', 'toAsset', 'rate', 'transactionId'],
    sentBy: 'TradesService / SettlementService on a BUY',
    subject: 'You bought {{toAmount}} {{toAsset}}',
    frame: {
      panel: { kind: 'done', label: 'You bought', value: '{{toAmount}} {{toAsset}}', sub: 'for ₦{{fromAmount}}' },
      details: [['You paid', '₦{{fromAmount}}'], ['You got', '{{toAmount}} {{toAsset}}'], ['Rate', '₦{{rate}} per {{toAsset}}'], ['Date', '{{date}}'], ['Reference', '{{transactionId}}']],
    },
    body: html(`Hi {{firstName}},

Your purchase is complete and the {{toAsset}} is in your wallet.`),
  },
  {
    key: 'trade.sell.completed',
    samples: { fromAmount: '0.0035', fromAsset: 'BTC', toAmount: '505078.00', rate: '144308000.00' },
    label: 'Crypto sell',
    hint: 'Sent when a sale to naira completes.',
    group: 'Trading',
    variables: ['fromAmount', 'fromAsset', 'toAmount', 'rate', 'transactionId'],
    sentBy: 'TradesService / SettlementService on a SELL',
    subject: 'You sold {{fromAmount}} {{fromAsset}}',
    frame: {
      panel: { kind: 'done', label: 'You sold', value: '{{fromAmount}} {{fromAsset}}', sub: 'for ₦{{toAmount}}' },
      details: [['You sold', '{{fromAmount}} {{fromAsset}}'], ['You got', '₦{{toAmount}}'], ['Rate', '₦{{rate}} per {{fromAsset}}'], ['Date', '{{date}}'], ['Reference', '{{transactionId}}']],
    },
    body: html(`Hi {{firstName}},

Your sale is complete and the naira is in your balance.`),
  },
  {
    key: 'trade.swap.completed',
    samples: { fromAmount: '50.00', fromAsset: 'USDT', toAmount: '0.00052', toAsset: 'BTC' },
    label: 'Coin swap',
    hint: 'Sent when a coin-to-coin swap settles.',
    group: 'Trading',
    variables: ['fromAmount', 'fromAsset', 'toAmount', 'toAsset', 'transactionId'],
    sentBy: 'SettlementService on a SWAP',
    subject: 'Your swap to {{toAsset}} is complete',
    frame: {
      panel: { kind: 'done', label: 'Swap complete', value: '{{toAmount}} {{toAsset}}', sub: 'from {{fromAmount}} {{fromAsset}}' },
      details: [['You swapped', '{{fromAmount}} {{fromAsset}}'], ['You got', '{{toAmount}} {{toAsset}}'], ['Date', '{{date}}'], ['Reference', '{{transactionId}}']],
    },
    body: html(`Hi {{firstName}},

Your swap has settled and the {{toAsset}} is in your wallet.`),
  },
  {
    key: 'trade.failed',
    label: 'Trade failed',
    hint: 'Sent when a trade could not complete. Nothing is deducted.',
    group: 'Trading',
    variables: ['reason', 'transactionId'],
    sentBy: 'SettlementService.reverse',
    subject: 'Your trade could not be completed',
    frame: {
      panel: { kind: 'problem', label: 'Trade not completed', value: 'Nothing was deducted' },
      details: [['Reason', '{{reason}}'], ['Date', '{{date}}'], ['Reference', '{{transactionId}}']],
    },
    body: html(`Hi {{firstName}},

Your trade didn't go through, and **nothing was taken from your balance**.
You're welcome to try again; the price will be quoted fresh.`),
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
    frame: {
      panel: { kind: 'done', label: 'Admin dashboard', value: 'You’ve been invited', sub: 'as {{role}}' },
      button: { label: 'Accept the invitation', url: '{{inviteUrl}}' },
    },
    body: html(`Hi {{firstName}},

{{invitedBy}} has added you to the {{companyName}} admin dashboard as
**{{role}}**. Use the button below to set your password.

The link works once and expires in {{expiresIn}}. If it runs out, use
**Forgot password** on the sign-in page.

Not expecting this? Ignore it and tell {{supportEmail}}.
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
    frame: { panel: { kind: 'code', label: 'Admin reset code', value: '{{code}}', sub: 'Expires in {{expiresIn}}' }, button: NO_BUTTON },
    body: html(`Hi {{firstName}},

Enter the code above to choose a new admin password. If you didn't ask for it,
ignore this email: your password hasn't changed.
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
    frame: {
      panel: { kind: 'security', label: 'Owner copy', value: 'Admin password reset', sub: '{{adminName}}' },
      details: [['Admin', '{{adminName}}'], ['Email', '{{adminEmail}}'], ['Their code', '{{code}}'], ['Valid for', '{{expiresIn}}']],
      status: false,
      button: NO_BUTTON,
    },
    body: html(`Hi {{firstName}},

**{{adminName}}** asked to reset their admin password. You're copied because
they are a sub-admin.

If they didn't ask for this, deactivate the account from **Settings → Team** now.`),
  },
  {
    key: 'admin.login_code',
    label: 'Admin sign-in code',
    hint: 'M7: the six-digit code an admin with two-step sign-in types after their password.',
    group: 'Admin team',
    variables: ['code', 'expiresIn'],
    sentBy: 'AdminOtpService.issue (LOGIN)',
    subject: 'Your {{companyName}} admin sign-in code',
    frame: { panel: { kind: 'code', label: 'Admin sign-in code', value: '{{code}}', sub: 'Expires in {{expiresIn}}' }, button: NO_BUTTON },
    body: html(`Hi {{firstName}},

Enter the code above to finish signing in.

If you didn't just sign in, someone has your password: change it now from
**Settings**, and tell an owner.
${SIGN_OFF}`),
  },
  {
    key: 'admin.two_step_code',
    label: 'Admin two-step change code',
    hint: 'M7: confirms an admin is switching two-step sign-in on or off.',
    group: 'Admin team',
    variables: ['code', 'expiresIn'],
    sentBy: 'AdminOtpService.issue (TWO_STEP_CHANGE)',
    subject: 'Confirm your {{companyName}} two-step sign-in change',
    frame: { panel: { kind: 'code', label: 'Two-step change code', value: '{{code}}', sub: 'Expires in {{expiresIn}}' }, button: NO_BUTTON },
    body: html(`Hi {{firstName}},

Enter the code above to confirm the change to your two-step sign-in.

If you didn't ask for this, change your password now and tell an owner.
${SIGN_OFF}`),
  },
  {
    key: 'admin.two_step_backup_used',
    label: 'Admin backup code used',
    hint: 'M7: security notice after a backup code is used to sign in.',
    group: 'Admin team',
    variables: ['left'],
    sentBy: 'AdminAuthController.verifyLogin',
    subject: 'A backup code was used to sign in to {{companyName}} admin',
    frame: { panel: { kind: 'security', label: 'Security notice', value: 'A backup code was used', sub: '{{left}} left' }, button: NO_BUTTON },
    body: html(`Hi {{firstName}},

One of your two-step backup codes was just used to sign in. You have
**{{left}}** left.

If this wasn't you, change your password now and tell an owner. You can make a
new set of backup codes from **Settings → Security**.
${SIGN_OFF}`),
  },
  {
    key: 'admin.two_step_disabled',
    label: 'Admin two-step switched off',
    hint: 'M7: security notice after an admin switches two-step sign-in off.',
    group: 'Admin team',
    variables: [],
    sentBy: 'TwoStepService.disable',
    subject: 'Two-step sign-in was switched off for your {{companyName}} admin account',
    frame: { panel: { kind: 'security', label: 'Security notice', value: 'Two-step sign-in is off' }, button: NO_BUTTON },
    body: html(`Hi {{firstName}},

Two-step sign-in was just switched off for your admin account. Signing in now
needs only your password.

If this wasn't you, change your password now and tell an owner.
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
    frame: { panel: { kind: 'security', label: 'Security notice', value: 'Your admin password was changed', sub: '{{changedAt}}' }, button: NO_BUTTON },
    body: html(`Hi {{firstName}},

The password on your admin account was changed ({{method}}). Every other
session has been signed out.

**Wasn't you?** Contact {{supportEmail}} immediately: an admin account can move
money.
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
  destination: 'GTBank ••••4471',
  txHash: '3f1a9c0e5b7d2a4c6e8f0b1d3a5c7e9f1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a',
  adminName: 'Tunde Bello',
  adminEmail: 'tunde@davochain.com',
  left: '9',
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
