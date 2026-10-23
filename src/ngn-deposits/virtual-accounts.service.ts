import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AlertType, KycStatus, KycTier, UserStatus, VirtualAccount, VirtualAccountStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { redactIds } from '../common/redact';
import { PayrepApi } from '../payrep/payrep.api';
import { PayrepConfig } from '../payrep/payrep.config';
import { PayrepError } from '../payrep/payrep.errors';
import type { PayrepCustomerAccount } from '../payrep/payrep.types';
import { OpsAlertsService } from '../common/ops-alerts/ops-alerts.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReadinessService } from './readiness.service';

const MINUTE = 60_000;
const CREATING_LOCK_MS = 2 * MINUTE;
/**
 * After an unclear answer, how long before we look in Payrep's account list.
 * Short: we never send blind again, we look first (spec 2026-10-23 §4.3).
 */
const UNKNOWN_COOLDOWN_MS = 2 * MINUTE;
/** Two possible accounts and no way to tell: a person looks; after this, a fresh one is opened. */
const NEEDS_PERSON_MS = 24 * 60 * MINUTE;
/** How far before the attempt we look in the list (Payrep's clock may differ a little from ours). */
const CLOCK_SLACK_MS = MINUTE;
const ATTEMPT_WINDOW_MS = 24 * 60 * MINUTE;
const MAX_ATTEMPTS = 5;
const SIX_HOURS = 6 * 60 * MINUTE;
const DAY = 24 * 60 * MINUTE;
const MAX_NAME = 200;
export const DEFAULT_VA_BANK_NAME = 'Payrep MFB';

/** Who asked: a tap in the app, the app reading the account, or the background opener. */
export type OpenTrigger = 'POST' | 'GET' | 'AUTO';

const TIER_RANK: Record<KycTier, number> = { TIER_0: 0, TIER_1: 1, TIER_2: 2, TIER_3: 3 };
const PENDING_MESSAGE = "We're setting up your account. Try again in a few minutes.";

export interface VirtualAccountView {
  accountNumber: string;
  accountName: string;
  bankName: string;
  status: 'ACTIVE' | 'INACTIVE';
}

export interface OpenAccountResult {
  httpStatus: 200 | 201 | 202;
  body: VirtualAccountView | { status: 'PENDING'; message: string };
}

/** Whose deposit account this is, and whether an admin or compliance switched it off. */
export interface AccountOwner {
  userId: string;
  switchedOff: boolean;
}

export interface AdminVirtualAccount {
  id: string;
  accountNumber: string;
  accountName: string;
  bankName: string;
  providerRef: string | null;
  source: string;
  isPrimary: boolean;
  identityType: string | null;
  desiredStatus: VirtualAccountStatus;
  providerStatus: string | null;
  createdAt: Date;
}

/**
 * Permanent Payrep deposit accounts, one per customer (spec 2026-10-23).
 *
 * Opened with Payrep's create_account: an account under DavoChain's business,
 * pooled into our main account, named after the customer as their ID shows it.
 * No BVN or NIN is sent: DavoChain has already verified the person with Dojah.
 * It is opened automatically once Basic is approved (the background opener and
 * the first GET), and a tap can ask for it too.
 *
 * Payrep opens a NEW account every time it is asked, so an unclear answer is
 * never followed by a blind retry: we look for the account in Payrep's list
 * first (name, created after our attempt, not already someone else's).
 *
 * Payrep has no API to switch an account off. "Off" is recorded here, and
 * deposits into an account that is off are HELD for an admin (pay-in.service.ts).
 */
@Injectable()
export class VirtualAccountsService {
  private readonly log = new Logger(VirtualAccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payrep: PayrepApi,
    private readonly payrepCfg: PayrepConfig,
    private readonly readiness: ReadinessService,
    private readonly alerts: OpsAlertsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── the customer's side ───────────────────────────────────

  /**
   * GET: the account; for an eligible customer without one, it is opened there
   * and then (or 202 while it is being opened). 404 NO_VIRTUAL_ACCOUNT only for
   * someone who may not have one, with the reason.
   */
  async getForUser(userId: string): Promise<OpenAccountResult> {
    const account = await this.primaryFor(userId);
    if (account) return { httpStatus: 200, body: this.view(account) };
    const { eligible, reason } = await this.eligibility(userId);
    if (!eligible) {
      throw new NotFoundException({ statusCode: 404, code: 'NO_VIRTUAL_ACCOUNT', eligible, reason, message: 'You have no naira deposit account yet.' });
    }
    const r = await this.ensure(userId, 'GET');
    return r.httpStatus === 201 ? { httpStatus: 200, body: r.body } : r;
  }

  async eligibility(userId: string): Promise<{ eligible: boolean; reason: string | null }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return { eligible: false, reason: 'Account not found.' };
    if (user.status !== UserStatus.ACTIVE) {
      return { eligible: false, reason: 'Your account is not active. Contact support.' };
    }
    if (user.kycStatus !== KycStatus.APPROVED || TIER_RANK[user.kycTier] < TIER_RANK.TIER_1) {
      return { eligible: false, reason: 'Verify your identity (Tier 1) to get a naira account.' };
    }
    // Final review C1: nobody under review, restricted or blocked gets a way to receive naira.
    if (user.amlStatus !== 'CLEAR') {
      return {
        eligible: false,
        reason:
          user.amlStatus === 'PENDING' || user.amlStatus === 'NOT_SCREENED'
            ? 'Your verification is still being completed.'
            : 'Your account is under review. Contact support.',
      };
    }
    const readiness = await this.readiness.report();
    if (!readiness.depositsEnabled) return { eligible: false, reason: 'Naira deposits are not available yet.' };
    if (!readiness.canCreateAccounts) {
      return { eligible: false, reason: 'Naira deposits are temporarily unavailable. Try again later.' };
    }
    return { eligible: true, reason: null };
  }

  /**
   * POST (a tap): open it now, or say it is on its way. Older app builds send a
   * bvn or nin: accepted and ignored, never sent, stored or logged.
   */
  async openForUser(userId: string, _input: { bvn?: string; nin?: string } = {}): Promise<OpenAccountResult> {
    return this.ensure(userId, 'POST');
  }

  /**
   * The one way an account gets opened. 201 opened now, 200 already had one,
   * 202 on its way (being opened, or an unclear answer being checked).
   * POST also throws 403 (not eligible), 429 (too many tries today) and 503
   * (Payrep or our setup can't do it right now); GET and AUTO answer 202 instead.
   */
  async ensure(userId: string, trigger: OpenTrigger): Promise<OpenAccountResult> {
    const pending: OpenAccountResult = { httpStatus: 202, body: { status: 'PENDING', message: PENDING_MESSAGE } };

    // 1. Already has one: hand it back. Nothing goes to Payrep.
    const existing = await this.primaryFor(userId);
    if (existing) return { httpStatus: 200, body: this.view(existing) };

    // 2. Allowed to have one?
    const { eligible, reason } = await this.eligibility(userId);
    if (!eligible) {
      if (trigger === 'POST') throw new ForbiddenException({ statusCode: 403, code: 'NOT_ELIGIBLE', message: reason });
      return pending;
    }

    // 3. One attempt at a time, five a day.
    let claim: Claim;
    try {
      claim = await this.claim(userId);
    } catch (err) {
      if (err instanceof ConflictException) return pending;
      if (trigger !== 'POST' && err instanceof HttpException) return pending;
      throw err;
    }
    if (claim.existing) return { httpStatus: 200, body: this.view(claim.existing) };

    const attemptStart = claim.attemptStart;
    let state: RequestState = 'IDLE';
    let stateSince = new Date();
    let lastError: string | null = null;
    try {
      const pool = this.payrepCfg.mainAccount;
      if (!pool) {
        lastError = 'PAYREP_MAIN_ACCOUNT is not set';
        await this.alerts.raise(AlertType.NAIRA_RAIL_CONFIG, 'config', 'Naira deposit accounts are off: PAYREP_MAIN_ACCOUNT is not set', [lastError]);
        return this.unavailableFor(trigger, pending);
      }
      const name = await this.accountName(userId);

      // 4. The last try's answer was lost: look for that account before sending again.
      if (claim.previousUnknownSince) {
        const found = await this.lookForLostAccount(userId, name, claim.previousUnknownSince);
        if (found.kind === 'UNREADABLE') {
          state = 'UNKNOWN';
          stateSince = claim.previousUnknownSince;
          lastError = 'Payrep account list could not be read; will look again';
          return pending;
        }
        if (found.kind === 'AMBIGUOUS') {
          state = 'NEEDS_PERSON';
          lastError = `Several possible accounts: ${found.numbers.join(', ')}`;
          await this.alerts.raise(
            AlertType.VIRTUAL_ACCOUNT_SYNC,
            `va-ambiguous:${userId}`,
            'Payrep may have opened more than one deposit account for a customer',
            [
              `User: ${userId}`,
              `Possible accounts: ${found.numbers.join(', ')}`,
              'None was linked, so no deposit can go to the wrong person. Deposits into these numbers are held as unmatched.',
              'A fresh account is opened for the customer in 24 hours unless you link one before then.',
            ],
            DAY,
          );
          return pending;
        }
        if (found.kind === 'FOUND') {
          const done = await this.keep(userId, found.account, name);
          state = done.state;
          lastError = done.lastError;
          if (done.state === 'UNKNOWN') stateSince = claim.previousUnknownSince;
          return done.result;
        }
        // NONE: nothing was opened last time, so it is safe to send.
      }

      // 5. Ask Payrep. Sent exactly once.
      let created: PayrepCustomerAccount;
      try {
        created = await this.payrep.createAccount({ accountName: name, poolAccountNumber: pool });
      } catch (err) {
        lastError = redactIds((err as Error).message).slice(0, 500);
        // Payrep's rate limit: nothing was sent, so trying again later is safe.
        if (err instanceof PayrepError && err.kind === 'BUSY') return this.unavailableFor(trigger, pending);
        if (err instanceof PayrepError && err.kind === 'CONFIG') {
          await this.alerts.raise(AlertType.NAIRA_RAIL_CONFIG, 'config', 'Payrep refused to open a deposit account', [lastError]);
          return this.unavailableFor(trigger, pending);
        }
        // Unclear: Payrep may have opened it. Look in its list before ever sending again.
        state = 'UNKNOWN';
        stateSince = attemptStart;
        this.log.warn(`Deposit account for ${userId}: outcome unknown (${lastError})`);
        await this.alerts.raise(
          AlertType.VIRTUAL_ACCOUNT_SYNC,
          `va-unknown:${userId}`,
          'Payrep gave no clear answer to opening a deposit account',
          [
            `User: ${userId}`,
            `Answer: ${lastError}`,
            "Nothing to do yet: in a few minutes we look for the account in Payrep's list and keep it if it was opened. A second account is never opened blind.",
          ],
          SIX_HOURS,
        );
        return pending;
      }

      const done = await this.keep(userId, created, name);
      state = done.state;
      lastError = done.lastError;
      if (done.state === 'UNKNOWN') stateSince = attemptStart;
      return done.result;
    } finally {
      await this.release(userId, state, stateSince, lastError);
    }
  }

  /** Records an account Payrep opened (or that we found), tells the customer, checks the name. */
  private async keep(
    userId: string,
    account: PayrepCustomerAccount,
    sentName: string,
  ): Promise<{ result: OpenAccountResult; state: RequestState; lastError: string | null }> {
    let saved: VirtualAccount;
    try {
      saved = await this.record(userId, account, sentName);
    } catch (err) {
      // Payrep has the account; we failed to write it down. The next try finds it in Payrep's list.
      const lastError = redactIds((err as Error).message).slice(0, 500);
      this.log.error(`Payrep opened account ${account.accountNumber} for ${userId}, but recording it failed: ${lastError}`);
      await this.alerts.raise(
        AlertType.VIRTUAL_ACCOUNT_SYNC,
        `va-unrecorded:${account.accountNumber}`,
        `Deposit account ${account.accountNumber} was opened but not recorded`,
        [`User: ${userId}`, `Account number: ${account.accountNumber}`, `Error: ${lastError}`, 'It is picked up automatically on the next try.'],
        SIX_HOURS,
      );
      return { result: { httpStatus: 202, body: { status: 'PENDING', message: PENDING_MESSAGE } }, state: 'UNKNOWN', lastError };
    }

    if (!/davochain/i.test(saved.accountName)) {
      await this.alerts
        .raise(
          AlertType.NAIRA_RAIL_CONFIG,
          'payrep-account-name-prefix',
          'Payrep opened a naira account without "DavoChain" in its name',
          [
            `Account ${saved.accountNumber} is named "${saved.accountName}".`,
            'Senders see this name in their bank app. To add it ourselves, set PAYREP_ACCOUNT_NAME_PREFIX=DavoChain- in api/.env and restart.',
            'Accounts already opened keep their names.',
          ],
          30 * DAY,
        )
        .catch(() => undefined);
    }

    await this.notifications
      .notify({
        userId,
        type: 'ngn_account.ready',
        title: 'Your naira account is ready',
        body: `Send money to ${saved.accountNumber} (${saved.bankName}) from any bank app to fund your naira balance.`,
      })
      .catch((err: Error) => this.log.warn(`Could not tell ${userId} their account is ready: ${redactIds(err.message)}`));

    if (saved.isPrimary) return { result: { httpStatus: 201, body: this.view(saved) }, state: 'IDLE', lastError: null };
    const primary = await this.primaryFor(userId);
    return { result: { httpStatus: 200, body: this.view(primary ?? saved) }, state: 'IDLE', lastError: null };
  }

  /**
   * After a lost answer: did Payrep open it? One account with the name we sent,
   * created after the attempt began and not already someone else's, is ours.
   */
  private async lookForLostAccount(
    userId: string,
    name: string,
    attemptStart: Date,
  ): Promise<{ kind: 'FOUND'; account: PayrepCustomerAccount } | { kind: 'NONE' } | { kind: 'AMBIGUOUS'; numbers: string[] } | { kind: 'UNREADABLE' }> {
    const since = new Date(attemptStart.getTime() - CLOCK_SLACK_MS);
    const list = await this.payrep.recentAccounts({ since }).catch(() => null);
    if (!list) return { kind: 'UNREADABLE' };
    const want = tidy(name).toUpperCase();
    const named = list.filter((acct) => {
      const got = tidy(acct.accountName).toUpperCase();
      // Payrep puts our business name in front: "DavoChain-ADA OBI" is "ADA OBI".
      return acct.createdAt >= since && (got === want || got.endsWith(want));
    });
    if (named.length === 0) return { kind: 'NONE' };
    const known = await this.prisma.virtualAccount.findMany({ where: { accountNumber: { in: named.map((acct) => acct.accountNumber) } } });
    const ours = known.find((k) => k.userId === userId);
    if (ours) {
      return {
        kind: 'FOUND',
        account: { accountNumber: ours.accountNumber, accountName: ours.accountName, bankName: ours.bankName, status: ours.providerStatus ?? 'active', providerRef: ours.providerRef },
      };
    }
    const free = named.filter((acct) => !known.some((k) => k.accountNumber === acct.accountNumber));
    if (free.length === 0) return { kind: 'NONE' };
    if (free.length > 1) return { kind: 'AMBIGUOUS', numbers: free.map((acct) => acct.accountNumber) };
    const one = free[0];
    return { kind: 'FOUND', account: { accountNumber: one.accountNumber, accountName: one.accountName, bankName: DEFAULT_VA_BANK_NAME, status: 'active', providerRef: null } };
  }

  /** The name on the customer's ID (Dojah's record), else the name on their DavoChain account. */
  private async accountName(userId: string): Promise<string> {
    const v = await this.prisma.kycVerification.findFirst({
      where: { userId, recordFirstName: { not: null }, recordLastName: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
    let name = v ? tidy([v.recordFirstName, v.recordMiddleName, v.recordLastName].filter(Boolean).join(' ')) : '';
    if (!name) {
      const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
      name = tidy(`${user.firstName} ${user.lastName}`);
    }
    return `${this.payrepCfg.accountNamePrefix ?? ''}${name}`.slice(0, MAX_NAME);
  }

  private unavailableFor(trigger: OpenTrigger, pending: OpenAccountResult): OpenAccountResult {
    if (trigger === 'POST') throw this.unavailable();
    return pending;
  }

  // ── routing deposits ──────────────────────────────────────

  /** Whose deposit is this? Payrep accounts are real, unique numbers (spec §6). */
  async findOwnerByAccount(accountNumber: string): Promise<AccountOwner | null> {
    const va = await this.prisma.virtualAccount.findUnique({ where: { accountNumber } });
    return va ? { userId: va.userId, switchedOff: va.desiredStatus === VirtualAccountStatus.INACTIVE } : null;
  }

  // ── "off": ours to enforce ────────────────────────────────

  /**
   * Suspension and reinstatement hooks. Never throws: a suspension must not
   * fail on a database hiccup here. Payrep has no API to switch an account off,
   * so only the wish is saved; deposits into an account that is off are HELD.
   * `opts` is kept for the existing callers.
   */
  async setDesiredForUser(userId: string, desired: VirtualAccountStatus, _opts: { background?: boolean } = {}): Promise<void> {
    try {
      await this.prisma.virtualAccount.updateMany({ where: { userId }, data: { desiredStatus: desired } });
    } catch (err) {
      this.log.error(`Could not set ${userId}'s deposit accounts ${desired}: ${redactIds((err as Error).message)}`);
    }
  }

  async setDesired(
    userId: string,
    vaId: string,
    desired: VirtualAccountStatus,
  ): Promise<{ before: AdminVirtualAccount; after: AdminVirtualAccount }> {
    const va = await this.prisma.virtualAccount.findFirst({ where: { id: vaId, userId } });
    if (!va) throw new NotFoundException('No such virtual account for this user');
    const updated = await this.prisma.virtualAccount.update({ where: { id: vaId }, data: { desiredStatus: desired } });
    return { before: this.adminView(va), after: this.adminView(updated) };
  }

  async listForUser(userId: string): Promise<AdminVirtualAccount[]> {
    const rows = await this.prisma.virtualAccount.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => this.adminView(r));
  }

  // ── internals ─────────────────────────────────────────────

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      statusCode: 503,
      code: 'DEPOSITS_UNAVAILABLE',
      message: 'Naira deposits are temporarily unavailable. Try again later.',
    });
  }

  private primaryFor(userId: string): Promise<VirtualAccount | null> {
    return this.prisma.virtualAccount.findFirst({ where: { userId, isPrimary: true }, orderBy: { createdAt: 'asc' } });
  }

  private view(va: VirtualAccount): VirtualAccountView {
    const live = va.desiredStatus === VirtualAccountStatus.ACTIVE && va.providerStatus !== 'inactive';
    return {
      accountNumber: va.accountNumber,
      accountName: va.accountName,
      bankName: va.bankName,
      status: live ? 'ACTIVE' : 'INACTIVE',
    };
  }

  private adminView(va: VirtualAccount): AdminVirtualAccount {
    return {
      id: va.id,
      accountNumber: va.accountNumber,
      accountName: va.accountName,
      bankName: va.bankName,
      providerRef: va.providerRef,
      source: va.source,
      isPrimary: va.isPrimary,
      identityType: va.identityType,
      desiredStatus: va.desiredStatus,
      providerStatus: va.providerStatus,
      createdAt: va.createdAt,
    };
  }

  /**
   * Takes the per-customer lock. Says whether the last try's answer was lost
   * (so we look before sending) and when this attempt starts.
   */
  private async claim(userId: string): Promise<Claim> {
    const conflict = "We're already setting up your account. Try again in a minute.";
    return this.prisma.serializable(
      async (t) => {
        const existing = await t.virtualAccount.findFirst({ where: { userId, isPrimary: true }, orderBy: { createdAt: 'asc' } });
        if (existing) return { existing, attemptStart: new Date(), previousUnknownSince: null }; // opened while this waited
        const now = new Date();
        const row = await t.virtualAccountRequest.findUnique({ where: { userId } });
        const since = row ? now.getTime() - row.stateSince.getTime() : Infinity;
        if (row?.state === 'CREATING' && since < CREATING_LOCK_MS) {
          throw new ConflictException({ statusCode: 409, code: 'ALREADY_CREATING', message: conflict });
        }
        // The last answer was lost: give Payrep's list a moment to show the account.
        if (row?.state === 'UNKNOWN' && since < UNKNOWN_COOLDOWN_MS) {
          throw new ConflictException({ statusCode: 409, code: 'ALREADY_CREATING', message: PENDING_MESSAGE });
        }
        if (row?.state === 'NEEDS_PERSON' && since < NEEDS_PERSON_MS) {
          throw new ConflictException({ statusCode: 409, code: 'ALREADY_CREATING', message: PENDING_MESSAGE });
        }
        const windowStart =
          row?.windowStartedAt && now.getTime() - row.windowStartedAt.getTime() < ATTEMPT_WINDOW_MS ? row.windowStartedAt : null;
        const attempts = windowStart ? (row?.attemptsInWindow ?? 0) : 0;
        if (attempts >= MAX_ATTEMPTS) {
          throw new HttpException(
            { statusCode: 429, code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts today. Try again tomorrow, or contact support.' },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        // While UNKNOWN, stateSince is when that attempt began (the list is searched from there).
        const previousUnknownSince = row?.state === 'UNKNOWN' ? row.stateSince : null;
        const data = { state: 'CREATING', stateSince: now, windowStartedAt: windowStart ?? now, attemptsInWindow: attempts + 1, lastError: null };
        await t.virtualAccountRequest.upsert({ where: { userId }, create: { userId, ...data }, update: data });
        return { existing: null, attemptStart: now, previousUnknownSince };
      },
      { conflict },
    );
  }

  private async release(userId: string, state: RequestState, since: Date, lastError: string | null): Promise<void> {
    try {
      await this.prisma.virtualAccountRequest.update({ where: { userId }, data: { state, stateSince: since, lastError } });
    } catch (err) {
      this.log.error(`Could not release ${userId}'s account request: ${redactIds((err as Error).message)}`);
    }
  }

  private record(userId: string, created: PayrepCustomerAccount, sentName: string): Promise<VirtualAccount> {
    return this.prisma.serializable(async (t) => {
      const hasPrimary = (await t.virtualAccount.count({ where: { userId, isPrimary: true } })) > 0;
      return t.virtualAccount.create({
        data: {
          userId,
          provider: 'PAYREP',
          providerRef: created.providerRef,
          accountNumber: created.accountNumber,
          accountName: created.accountName || sentName,
          bankName: created.bankName || DEFAULT_VA_BANK_NAME,
          identityType: null,
          isPrimary: !hasPrimary,
          source: 'CREATED',
          providerStatus: created.status || 'active',
        },
      });
    });
  }
}

type RequestState = 'IDLE' | 'UNKNOWN' | 'NEEDS_PERSON';
interface Claim {
  existing: VirtualAccount | null;
  attemptStart: Date;
  previousUnknownSince: Date | null;
}

const tidy = (v: string) => v.replace(/\s+/g, ' ').trim();
