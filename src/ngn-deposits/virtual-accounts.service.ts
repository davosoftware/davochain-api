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
import { FlutterwaveClient } from '../flutterwave/flutterwave.client';
import { FlutterwaveError, redactIds } from '../flutterwave/flutterwave.errors';
import type { FlwStaticAccount } from '../flutterwave/flutterwave.types';
import { KycHashService } from '../kyc/kyc-hash';
import { OpsAlertsService } from '../common/ops-alerts/ops-alerts.service';
import { ReadinessService } from './readiness.service';
import { txRefForUser, userIdFromTxRef } from './tx-ref';

const CREATING_LOCK_MS = 2 * 60_000;
const ATTEMPT_WINDOW_MS = 24 * 3_600_000;
const MAX_ATTEMPTS = 5;
const SYNC_ALERT_AFTER = 3;
const SIX_HOURS = 6 * 3_600_000;
export const DEFAULT_VA_BANK_NAME = 'Flutterwave MFB';

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

export interface AccountOwner {
  userId: string;
  via: 'TX_REF' | 'ACCOUNT_NUMBER';
  /** False when the tx_ref is ours but the paid account number is not on record yet. */
  accountKnown: boolean;
}

export interface AdminVirtualAccount {
  id: string;
  accountNumber: string;
  accountName: string;
  bankName: string;
  orderRef: string | null;
  source: string;
  isPrimary: boolean;
  identityType: string | null;
  desiredStatus: VirtualAccountStatus;
  providerStatus: string | null;
  lastSyncedAt: Date | null;
  syncError: string | null;
  syncFailures: number;
  createdAt: Date;
}

/**
 * Permanent Flutterwave virtual accounts, one per customer (spec §6.4).
 *
 * The BVN or NIN arrives in one request, is checked against the KYC hash, is
 * sent once to Flutterwave, and is gone: it is never stored, logged, queued or
 * put in an error. Creation is not idempotent at Flutterwave, so an unknown
 * outcome is never treated as a failure. Any account it did make carries this
 * user's tx_ref, and the first deposit into it routes here and records it.
 */
@Injectable()
export class VirtualAccountsService {
  private readonly log = new Logger(VirtualAccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: FlutterwaveClient,
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

    // 1. Already has one: hand it back. Nothing goes to Flutterwave.
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

      // 5. Ask Flutterwave. Sent exactly once.
      const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
      const narration = `${user.firstName} ${user.lastName}`.trim();
      let created: FlwStaticAccount;
      try {
        created = await this.client.createStaticVirtualAccount({
          email: user.email,
          txRef: txRefForUser(userId),
          firstName: user.firstName,
          lastName: user.lastName,
          narration,
          ...(identityType === 'BVN' ? { bvn: value } : { nin: value }),
        });
      } catch (err) {
        lastError = redactIds((err as Error).message).slice(0, 500);
        if (err instanceof FlutterwaveError && err.kind === 'CONFIG') {
          await this.alerts.raise(AlertType.FLUTTERWAVE_CONFIG, 'config', 'Flutterwave refused to open a virtual account', [lastError]);
          throw new ServiceUnavailableException({
            statusCode: 503,
            code: 'DEPOSITS_UNAVAILABLE',
            message: 'Naira deposits are temporarily unavailable. Try again later.',
          });
        }
        if (err instanceof FlutterwaveError && err.kind !== 'RATE_LIMITED') {
          throw new BadRequestException({
            statusCode: 400,
            code: 'PROVIDER_REJECTED',
            message: `Flutterwave could not open an account with that ${identityType}. Check the number and try again.`,
          });
        }
        // Unknown (or throttled): Flutterwave may well have made the account.
        state = 'UNKNOWN';
        this.log.warn(`Virtual account for ${userId}: outcome unknown (${lastError})`);
        return { httpStatus: 202, body: { status: 'PENDING', message: PENDING_MESSAGE } };
      }

      // Flutterwave has it. If recording fails, the first deposit still routes by tx_ref.
      state = 'UNKNOWN';
      let account: VirtualAccount;
      try {
        account = await this.record(userId, created, narration, identityType);
      } catch (err) {
        // Flutterwave has the account; we failed to write it down. Keep what ops needs to manage it.
        lastError = redactIds((err as Error).message).slice(0, 500);
        this.log.error(`Flutterwave opened account ${created.account_number} (order ${created.order_ref}) for ${userId}, but recording it failed: ${lastError}`);
        await this.alerts.raise(
          AlertType.VIRTUAL_ACCOUNT_SYNC,
          `va-unrecorded:${created.order_ref}`,
          `Virtual account ${created.account_number} was opened but not recorded`,
          [`User: ${userId}`, `Order ref: ${created.order_ref}`, `Account number: ${created.account_number}`, `Error: ${lastError}`],
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

  /** Whose payment is this? Our tx_ref first; then Flutterwave's record of the account paid. */
  async findOwner(
    txRef: string | null | undefined,
    accountNumber: string | null | undefined,
  ): Promise<AccountOwner | null> {
    const fromRef = userIdFromTxRef(txRef);
    if (fromRef) {
      const user = await this.prisma.user.findUnique({ where: { id: fromRef } });
      if (user) {
        const accountKnown = accountNumber
          ? (await this.prisma.virtualAccount.count({ where: { userId: user.id, accountNumber } })) > 0
          : true;
        return { userId: user.id, via: 'TX_REF', accountKnown };
      }
    }
    if (accountNumber) {
      const matches = await this.prisma.virtualAccount.findMany({ where: { accountNumber } });
      const owners = [...new Set(matches.map((m) => m.userId))];
      // Two owners for one number (Flutterwave's test mode does this) means we cannot tell.
      if (owners.length === 1) return { userId: owners[0], via: 'ACCOUNT_NUMBER', accountKnown: true };
    }
    return null;
  }

  /** An account we learned about from a deposit instead of from creating it. */
  async recordDiscovered(userId: string, accountNumber: string): Promise<VirtualAccount> {
    const account = await this.prisma.serializable(async (t) => {
      const known = await t.virtualAccount.findFirst({ where: { userId, accountNumber } });
      if (known) return { account: known, created: false };
      const user = await t.user.findUniqueOrThrow({ where: { id: userId } });
      const primary = await t.virtualAccount.findFirst({ where: { userId, isPrimary: true } });
      const created = await t.virtualAccount.create({
        data: {
          userId,
          orderRef: null,
          accountNumber,
          accountName: `${user.firstName} ${user.lastName}`.trim(),
          bankName: primary?.bankName ?? DEFAULT_VA_BANK_NAME,
          txRef: txRefForUser(userId),
          identityType: null,
          isPrimary: !primary,
          source: 'DISCOVERED',
          providerStatus: 'active',
          lastSyncedAt: new Date(),
        },
      });
      return { account: created, created: true };
    });
    if (account.created) {
      this.log.warn(`Discovered virtual account ${accountNumber} for ${userId} from a deposit; it has no order ref`);
    }
    return account.account;
  }

  // ── status: desired versus Flutterwave ────────────────────

  /**
   * Suspension and reinstatement hooks. Never throws: a suspension must not
   * fail on Flutterwave. The wish is saved first; with `background`, Flutterwave
   * is told after this returns (and the 10-minute sync retries), so a slow
   * provider never holds up the admin.
   */
  async setDesiredForUser(
    userId: string,
    desired: VirtualAccountStatus,
    opts: { background?: boolean } = {},
  ): Promise<void> {
    try {
      await this.prisma.virtualAccount.updateMany({ where: { userId }, data: { desiredStatus: desired } });
    } catch (err) {
      this.log.error(`Could not set ${userId}'s virtual accounts ${desired}: ${redactIds((err as Error).message)}`);
      return;
    }
    const pushAll = async (): Promise<void> => {
      try {
        const managed = await this.prisma.virtualAccount.findMany({ where: { userId, orderRef: { not: null } } });
        for (const va of managed) await this.push(va);
      } catch (err) {
        this.log.error(`Could not push ${userId}'s virtual accounts to Flutterwave: ${redactIds((err as Error).message)}`);
      }
    };
    if (opts.background) void pushAll();
    else await pushAll();
  }

  async setDesired(
    userId: string,
    vaId: string,
    desired: VirtualAccountStatus,
  ): Promise<{ before: AdminVirtualAccount; after: AdminVirtualAccount }> {
    const va = await this.prisma.virtualAccount.findFirst({ where: { id: vaId, userId } });
    if (!va) throw new NotFoundException('No such virtual account for this user');
    const updated = await this.prisma.virtualAccount.update({ where: { id: vaId }, data: { desiredStatus: desired } });
    const after = await this.push(updated);
    return { before: this.adminView(va), after: this.adminView(after) };
  }

  async listForUser(userId: string): Promise<AdminVirtualAccount[]> {
    const rows = await this.prisma.virtualAccount.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => this.adminView(r));
  }

  /** Every 10 minutes: push accounts whose Flutterwave status differs from what we want. */
  async syncStatuses(): Promise<{ checked: number; fixed: number; failing: number }> {
    const candidates = await this.prisma.virtualAccount.findMany({
      where: {
        orderRef: { not: null },
        OR: [
          { providerStatus: null },
          { desiredStatus: VirtualAccountStatus.ACTIVE, providerStatus: { not: 'active' } },
          { desiredStatus: VirtualAccountStatus.INACTIVE, providerStatus: { not: 'inactive' } },
        ],
      },
      orderBy: { updatedAt: 'asc' },
      take: 200,
    });
    let fixed = 0;
    let failing = 0;
    for (const va of candidates) {
      const after = await this.push(va);
      if (after.syncFailures === 0) {
        fixed++;
        continue;
      }
      failing++;
      if (after.syncFailures >= SYNC_ALERT_AFTER) {
        await this.alerts.raise(
          AlertType.VIRTUAL_ACCOUNT_SYNC,
          `va-sync:${va.id}`,
          `Virtual account ${va.accountNumber} will not sync with Flutterwave`,
          [
            `User: ${va.userId}`,
            `Wanted: ${va.desiredStatus}`,
            `Flutterwave reports: ${after.providerStatus ?? 'unknown'}`,
            `Last error: ${after.syncError ?? 'none'}`,
            `Failed runs: ${after.syncFailures}`,
          ],
          SIX_HOURS,
        );
      }
    }
    return { checked: candidates.length, fixed, failing };
  }

  // ── internals ─────────────────────────────────────────────

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
      orderRef: va.orderRef,
      source: va.source,
      isPrimary: va.isPrimary,
      identityType: va.identityType,
      desiredStatus: va.desiredStatus,
      providerStatus: va.providerStatus,
      lastSyncedAt: va.lastSyncedAt,
      syncError: va.syncError,
      syncFailures: va.syncFailures,
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
    created: FlwStaticAccount,
    accountName: string,
    identityType: 'BVN' | 'NIN',
  ): Promise<VirtualAccount> {
    return this.prisma.serializable(async (t) => {
      const hasPrimary = (await t.virtualAccount.count({ where: { userId, isPrimary: true } })) > 0;
      return t.virtualAccount.create({
        data: {
          userId,
          orderRef: created.order_ref,
          accountNumber: created.account_number,
          accountName,
          bankName: created.bank_name || DEFAULT_VA_BANK_NAME,
          txRef: txRefForUser(userId),
          flwRef: created.flw_ref ?? null,
          identityType,
          isPrimary: !hasPrimary,
          source: 'CREATED',
          providerStatus: (created.account_status ?? 'active').toLowerCase(),
          lastSyncedAt: new Date(),
        },
      });
    });
  }

  /** Make Flutterwave match desiredStatus, then read back what it says. Records the outcome; never throws for Flutterwave. */
  private async push(va: VirtualAccount): Promise<VirtualAccount> {
    if (!va.orderRef) return va;
    const target = va.desiredStatus === VirtualAccountStatus.ACTIVE ? 'active' : 'inactive';
    try {
      await this.client.setVirtualAccountStatus(va.orderRef, target);
      const fresh = await this.client.getVirtualAccount(va.orderRef);
      const providerStatus = fresh.account_status ? fresh.account_status.toLowerCase() : null;
      const synced = providerStatus === target;
      return await this.prisma.virtualAccount.update({
        where: { id: va.id },
        data: {
          providerStatus,
          lastSyncedAt: new Date(),
          syncError: synced ? null : `Flutterwave still reports ${providerStatus ?? 'no status'}`,
          syncFailures: synced ? 0 : { increment: 1 },
        },
      });
    } catch (err) {
      return this.prisma.virtualAccount.update({
        where: { id: va.id },
        data: { syncError: redactIds((err as Error).message).slice(0, 500), syncFailures: { increment: 1 } },
      });
    }
  }
}
