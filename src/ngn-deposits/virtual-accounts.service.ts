import {
  BadRequestException,
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
import { KycHashService } from '../kyc/kyc-hash';
import { OpsAlertsService } from '../common/ops-alerts/ops-alerts.service';
import { ReadinessService } from './readiness.service';
import { localNigerianPhone } from './phone';

const CREATING_LOCK_MS = 2 * 60_000;
/** After an unclear answer from Payrep, how long before the customer may try again. */
const UNKNOWN_COOLDOWN_MS = 30 * 60_000;
const ATTEMPT_WINDOW_MS = 24 * 3_600_000;
const MAX_ATTEMPTS = 5;
const SIX_HOURS = 6 * 3_600_000;
export const DEFAULT_VA_BANK_NAME = 'Payrep MFB';

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
 * Permanent Payrep deposit accounts, one per customer (spec 2026-10-20 §4),
 * pooled into our main account and named with our business prefix.
 *
 * The BVN or NIN arrives in one request, is checked against the KYC hash, is
 * sent once to Payrep, and is gone: it is never stored, logged, queued or put
 * in an error. Opening an account is not idempotent at Payrep, so an unknown
 * outcome is never treated as a failure; a deposit into a number we don't know
 * is held as UNMATCHED and alerts ops, who can link it.
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
    private readonly hasher: KycHashService,
    private readonly alerts: OpsAlertsService,
  ) {}

  // ── the customer's side ───────────────────────────────────

  async getForUser(userId: string): Promise<VirtualAccountView> {
    const account = await this.primaryFor(userId);
    if (account) return this.view(account);
    const { eligible, reason } = await this.eligibility(userId);
    throw new NotFoundException({
      statusCode: 404,
      code: 'NO_VIRTUAL_ACCOUNT',
      eligible,
      reason,
      message: 'You have no naira deposit account yet.',
    });
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

  async openForUser(userId: string, input: { bvn?: string; nin?: string }): Promise<OpenAccountResult> {
    const bvn = input.bvn?.trim();
    const nin = input.nin?.trim();
    if (!bvn === !nin) {
      throw new BadRequestException({ statusCode: 400, code: 'ONE_IDENTITY_NUMBER', message: 'Send exactly one of bvn or nin.' });
    }
    const identityType: 'BVN' | 'NIN' = bvn ? 'BVN' : 'NIN';
    const value = (bvn ?? nin) as string;
    if (!/^\d{11}$/.test(value)) {
      throw new BadRequestException({ statusCode: 400, code: 'BAD_IDENTITY_NUMBER', message: `A ${identityType} is 11 digits.` });
    }

    // 1. Already has one: hand it back. Nothing goes to Payrep.
    const existing = await this.primaryFor(userId);
    if (existing) return { httpStatus: 200, body: this.view(existing) };

    // 2. Allowed to have one?
    const { eligible, reason } = await this.eligibility(userId);
    if (!eligible) throw new ForbiddenException({ statusCode: 403, code: 'NOT_ELIGIBLE', message: reason });

    // 3. One attempt at a time, five a day. Every attempt counts, including a
    //    wrong number: it is also what stops anyone guessing at the hash.
    const appeared = await this.claim(userId);
    if (appeared) return { httpStatus: 200, body: this.view(appeared) };

    let state: 'IDLE' | 'UNKNOWN' = 'IDLE';
    let lastError: string | null = null;
    try {
      // 4. It must be the number KYC verified.
      try {
        await this.checkIdentity(userId, identityType, value);
      } catch (err) {
        lastError = 'The identity number did not match KYC';
        throw err;
      }

      // 5. Ask Payrep. Sent exactly once.
      const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
      const narration = `${user.firstName} ${user.lastName}`.trim();
      const pool = this.payrepCfg.mainAccount;
      if (!pool) {
        lastError = 'PAYREP_MAIN_ACCOUNT is not set';
        await this.alerts.raise(AlertType.NAIRA_RAIL_CONFIG, 'config', 'Naira deposit accounts are off: PAYREP_MAIN_ACCOUNT is not set', [lastError]);
        throw this.unavailable();
      }
      let created: PayrepCustomerAccount;
      try {
        created = await this.payrep.createCustomerAccount({
          ...(identityType === 'BVN' ? { bvn: value } : { nin: value }),
          phoneNumber: localNigerianPhone(user.phone),
          poolAccountNumber: pool,
        });
      } catch (err) {
        lastError = redactIds((err as Error).message).slice(0, 500);
        if (err instanceof PayrepError && err.kind === 'CONFIG') {
          await this.alerts.raise(AlertType.NAIRA_RAIL_CONFIG, 'config', 'Payrep refused to open a deposit account', [lastError]);
          throw this.unavailable();
        }
        if (err instanceof PayrepError && err.kind === 'REFUSED') {
          throw new BadRequestException({
            statusCode: 400,
            code: 'PROVIDER_REJECTED',
            message: `Payrep could not open an account with that ${identityType}. Check the number and try again.`,
          });
        }
        // Unclear: Payrep may have opened it. A deposit into a number we don't know is held as UNMATCHED and alerts ops.
        state = 'UNKNOWN';
        this.log.warn(`Deposit account for ${userId}: outcome unknown (${lastError})`);
        await this.alerts.raise(
          AlertType.VIRTUAL_ACCOUNT_SYNC,
          `va-unknown:${userId}`,
          'Payrep gave no clear answer to opening a deposit account',
          [
            `User: ${userId}`,
            `Answer: ${lastError}`,
            'Payrep may have opened it. Check the Payrep portal for a new account under our pool before the customer tries again (they can in 30 minutes).',
          ],
          SIX_HOURS,
        );
        return { httpStatus: 202, body: { status: 'PENDING', message: PENDING_MESSAGE } };
      }

      // Payrep has it. If recording fails, a deposit into this number is held as UNMATCHED and alerts ops, who can link it.
      state = 'UNKNOWN';
      let account: VirtualAccount;
      try {
        account = await this.record(userId, created, narration, identityType);
      } catch (err) {
        // Payrep has the account; we failed to write it down. Keep what ops needs to link it.
        lastError = redactIds((err as Error).message).slice(0, 500);
        this.log.error(`Payrep opened account ${created.accountNumber} for ${userId}, but recording it failed: ${lastError}`);
        await this.alerts.raise(
          AlertType.VIRTUAL_ACCOUNT_SYNC,
          `va-unrecorded:${created.accountNumber}`,
          `Deposit account ${created.accountNumber} was opened but not recorded`,
          [`User: ${userId}`, `Account number: ${created.accountNumber}`, `Payrep customer: ${created.providerRef ?? 'unknown'}`, `Error: ${lastError}`],
          SIX_HOURS,
        );
        return { httpStatus: 202, body: { status: 'PENDING', message: PENDING_MESSAGE } };
      }
      state = 'IDLE';
      if (account.isPrimary) return { httpStatus: 201, body: this.view(account) };
      const primary = await this.primaryFor(userId);
      return { httpStatus: 200, body: this.view(primary ?? account) };
    } finally {
      await this.release(userId, state, lastError);
    }
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

  private async claim(userId: string): Promise<VirtualAccount | null> {
    const conflict = "We're already setting up your account. Try again in a minute.";
    return this.prisma.serializable(
      async (t) => {
        const existing = await t.virtualAccount.findFirst({ where: { userId, isPrimary: true }, orderBy: { createdAt: 'asc' } });
        if (existing) return existing; // opened while this request waited: hand it back, claim nothing
        const now = new Date();
        const row = await t.virtualAccountRequest.findUnique({ where: { userId } });
        if (row?.state === 'CREATING' && now.getTime() - row.stateSince.getTime() < CREATING_LOCK_MS) {
          throw new ConflictException({ statusCode: 409, code: 'ALREADY_CREATING', message: conflict });
        }
        // Payrep may have opened an account on the last, unclear try: don't send the BVN again
        // straight away, so ops can look first (final review I5).
        if (row?.state === 'UNKNOWN' && now.getTime() - row.stateSince.getTime() < UNKNOWN_COOLDOWN_MS) {
          throw new ConflictException({ statusCode: 409, code: 'ALREADY_CREATING', message: PENDING_MESSAGE });
        }
        const windowStart =
          row?.windowStartedAt && now.getTime() - row.windowStartedAt.getTime() < ATTEMPT_WINDOW_MS
            ? row.windowStartedAt
            : null;
        const attempts = windowStart ? (row?.attemptsInWindow ?? 0) : 0;
        if (attempts >= MAX_ATTEMPTS) {
          throw new HttpException(
            {
              statusCode: 429,
              code: 'TOO_MANY_ATTEMPTS',
              message: 'Too many attempts today. Try again tomorrow, or contact support.',
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        const data = {
          state: 'CREATING',
          stateSince: now,
          windowStartedAt: windowStart ?? now,
          attemptsInWindow: attempts + 1,
          lastError: null,
        };
        await t.virtualAccountRequest.upsert({ where: { userId }, create: { userId, ...data }, update: data });
        return null;
      },
      { conflict },
    );
  }

  private async release(userId: string, state: 'IDLE' | 'UNKNOWN', lastError: string | null): Promise<void> {
    try {
      await this.prisma.virtualAccountRequest.update({
        where: { userId },
        data: { state, stateSince: new Date(), lastError },
      });
    } catch (err) {
      this.log.error(`Could not release ${userId}'s account request: ${redactIds((err as Error).message)}`);
    }
  }

  private async checkIdentity(userId: string, type: 'BVN' | 'NIN', value: string): Promise<void> {
    const profile = await this.prisma.kycProfile.findUnique({ where: { userId } });
    const stored = type === 'BVN' ? profile?.bvnHash : profile?.ninHash;
    if (!stored) {
      const other = type === 'BVN' ? profile?.ninHash : profile?.bvnHash;
      throw new BadRequestException({
        statusCode: 400,
        code: 'IDENTITY_TYPE_MISMATCH',
        message: other
          ? `You verified with your ${type === 'BVN' ? 'NIN' : 'BVN'}. Use that number.`
          : 'Verify your identity before opening a naira account.',
      });
    }
    if (!this.hasher.matches(value, stored)) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'IDENTITY_MISMATCH',
        message: `That ${type} doesn't match the one you verified with.`,
      });
    }
    if (this.hasher.isLegacy(stored)) {
      // A2: upgrade the plain SHA-256 to the keyed form while we hold the number.
      await this.prisma.kycProfile.update({
        where: { userId },
        data: type === 'BVN' ? { bvnHash: this.hasher.hash(value) } : { ninHash: this.hasher.hash(value) },
      });
    }
  }

  private record(
    userId: string,
    created: PayrepCustomerAccount,
    narration: string,
    identityType: 'BVN' | 'NIN',
  ): Promise<VirtualAccount> {
    return this.prisma.serializable(async (t) => {
      const hasPrimary = (await t.virtualAccount.count({ where: { userId, isPrimary: true } })) > 0;
      return t.virtualAccount.create({
        data: {
          userId,
          provider: 'PAYREP',
          providerRef: created.providerRef,
          accountNumber: created.accountNumber,
          accountName: created.accountName || narration,
          bankName: created.bankName || DEFAULT_VA_BANK_NAME,
          identityType,
          isPrimary: !hasPrimary,
          source: 'CREATED',
          providerStatus: created.status || 'active',
        },
      });
    });
  }
}
