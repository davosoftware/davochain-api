import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AlertType, type KycVerificationState, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DojahApi } from '../dojah/dojah.client';
import { DojahConfig, LEASE_MS } from '../dojah/dojah.config';
import { DojahError } from '../dojah/dojah.errors';
import type { LookupResult } from '../dojah/dojah.types';
import { AmlService, runEffects, type Effect, type Tx } from '../compliance/aml.service';
import { KycHashService } from './kyc-hash';
import { matchIdentity } from './name-match';
import { isValidLga, isValidState } from './ng-states';
import { lagosDate } from '../common/dates';
import { TemplatedMailService } from '../cms/templated-mail.service';
import { ReferralsService } from '../referrals/referrals.service';
import { OpsAlertsService } from '../common/ops-alerts/ops-alerts.service';
import { GATE_REVIEW } from '../auth/jwt-auth.guard';

export const MSG_UNAVAILABLE = 'Verification is temporarily unavailable. Please try again later.';
export const MSG_DISABLED = 'Verification is not available yet.';
export const MSG_IN_PROGRESS = 'A verification is already in progress.';
export const MSG_REVIEW = 'We are reviewing your details. We will email you when it is done.';
export const MSG_NOT_FOUND = 'We could not find that BVN/NIN. Check the number and try again.';
export const MSG_APPROVED = 'You are verified.';
export const MSG_DAILY = 'You have reached today’s verification limit. Try again tomorrow.';
export const MSG_TOTAL = 'You have used all your verification attempts. Contact support.';
export const MSG_ID_IN_USE = 'This BVN/NIN is already linked to another DavoChain account. Contact support.';

export interface BasicInput {
  idType: 'BVN' | 'NIN';
  idNumber: string;
  firstName: string;
  middleName?: string;
  lastName: string;
  dateOfBirth: string;
  address: { street: string; city: string; state: string; lga: string; postcode?: string };
  stateOfOrigin: string;
  country: 'NG';
}

export interface BasicResponse {
  state: KycVerificationState;
  level: 'NONE' | 'BASIC';
  message: string;
}

/** Whether Dojah may be called at all (spec §12.2). DojahReadinessService implements it. */
export interface Readiness {
  assertReady(): Promise<void>;
  markNotReady(reason: 'wallet' | 'keys'): void;
}
export const READINESS = Symbol('DOJAH_READINESS');

/** Failures worth telling ops about: everything except a plain rate limit. */
const ALERT_KINDS = new Set(['AUTH', 'IP', 'WALLET', 'BAD_REQUEST', 'CONFIG', 'SERVER', 'UNKNOWN', 'NOT_SENT']);

/**
 * Basic verification (spec §1, §7, §8): a Dojah lookup, an exact-after-cleanup
 * match and an AML screen. A clear pass is Basic at once; anything else goes to
 * a person. The raw BVN/NIN lives only in this request's memory.
 */
@Injectable()
export class BasicVerificationService implements OnModuleInit {
  private readonly log = new Logger(BasicVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dojah: DojahApi,
    private readonly cfg: DojahConfig,
    private readonly aml: AmlService,
    private readonly hasher: KycHashService,
    private readonly mail: TemplatedMailService,
    private readonly referrals: ReferralsService,
    private readonly alerts: OpsAlertsService,
    @Optional() @Inject(READINESS) private readonly readiness?: Readiness,
  ) {}

  onModuleInit(): void {
    this.aml.setApprovalHook((tx, id) => this.approve(tx, id));
  }

  async submit(userId: string, input: BasicInput): Promise<BasicResponse> {
    // The Dojah screen first, then api/.env (read fresh: a switch-off applies at once).
    const settings = await this.cfg.effective();
    if (!settings.basicEnabled) throw new ServiceUnavailableException(MSG_DISABLED);
    try {
      await this.readiness?.assertReady();
    } catch {
      throw new ServiceUnavailableException(MSG_UNAVAILABLE);
    }
    if (!isValidState(input.address.state) || !isValidLga(input.address.state, input.address.lga)) {
      throw new BadRequestException('Choose your state and LGA from the list');
    }
    if (!isValidState(input.stateOfOrigin)) throw new BadRequestException('Choose your state of origin from the list');

    const verificationId = await this.create(userId, input);

    // 1. Claim the lookup in its own commit (plan §R1.4.2).
    const claimed = await this.prisma.kycVerification.updateMany({
      where: { id: verificationId, state: 'CREATED', lookupOutcome: null },
      data: { lookupOutcome: 'IN_FLIGHT', lookupStartedAt: new Date() },
    });
    if (claimed.count !== 1) throw new ConflictException(MSG_IN_PROGRESS);

    // 2. The call. The raw number exists only in this frame.
    let lookup: LookupResult;
    try {
      lookup = await this.dojah.lookup(input.idType, input.idNumber);
    } catch (err) {
      const e = err instanceof DojahError ? err : new DojahError('UNKNOWN', (err as Error).message, 0);
      await this.prisma.kycVerification.updateMany({
        where: { id: verificationId, state: 'CREATED', lookupOutcome: 'IN_FLIGHT' },
        data: {
          state: 'FAILED_SYSTEM',
          activeFor: null,
          lookupOutcome: e.definitelyFailed ? 'DEFINITELY_FAILED' : 'UNKNOWN',
          possiblyCharged: !e.definitelyFailed,
          lookupHttpStatus: e.httpStatus || null,
          lookupCompletedAt: new Date(),
          failureReason: e.kind,
        },
      });
      if (e.kind === 'WALLET') this.readiness?.markNotReady('wallet');
      if (e.kind === 'AUTH' || e.kind === 'IP') this.readiness?.markNotReady('keys');
      if (ALERT_KINDS.has(e.kind)) {
        await this.alerts.raise(AlertType.DOJAH_CONFIG, `dojah:${e.kind}`, 'Dojah lookup failed: Basic verification affected', [e.message]);
      }
      throw new ServiceUnavailableException(MSG_UNAVAILABLE);
    }

    // 3. Record (second commit), and start AML in the same transaction.
    let screeningId: string | null = null;
    let screeningIsNew = false;
    const effects = await this.prisma.$transaction(async (tx) => {
      const out: Effect[] = [];
      if (!lookup.found) {
        const r = await tx.kycVerification.updateMany({
          where: { id: verificationId, state: 'CREATED', lookupOutcome: 'IN_FLIGHT' },
          data: {
            state: 'REJECTED_NOT_FOUND',
            activeFor: null,
            lookupOutcome: 'SUCCEEDED',
            lookupHttpStatus: 404,
            lookupCompletedAt: new Date(),
            // Whether Dojah bills a "not found" is unconfirmed (plan §R1.1): assume it does.
            possiblyCharged: true,
          },
        });
        if (r.count === 1) {
          await tx.kycProfile.updateMany({ where: { userId }, data: { status: 'REJECTED', rejectionReason: MSG_NOT_FOUND } });
          await tx.user.updateMany({ where: { id: userId }, data: { kycStatus: 'REJECTED' } });
          out.push(() => this.mailUser(userId, 'kyc.rejected', MSG_NOT_FOUND));
        }
        return out;
      }

      const id = lookup.identity;
      const match = matchIdentity(input, id);
      const reviewReason = !id.usable
        ? 'UNUSABLE_RECORD'
        : match.matched
          ? null
          : match.fields.dateOfBirth === 'MISMATCH' && match.fields.firstName === 'MATCH' && match.fields.lastName === 'MATCH'
            ? 'DOB_MISMATCH'
            : 'NAME_MISMATCH';
      const inputs = this.aml.amlInputs(id);
      if (inputs) {
        const s = await this.aml.startScreening(tx, userId, inputs);
        screeningId = s.id;
        screeningIsNew = !s.reused;
      }
      const r = await tx.kycVerification.updateMany({
        where: { id: verificationId, state: 'CREATED', lookupOutcome: 'IN_FLIGHT' },
        data: {
          state: 'LOOKED_UP',
          lookupOutcome: 'SUCCEEDED',
          lookupHttpStatus: lookup.httpStatus,
          lookupCompletedAt: new Date(),
          possiblyCharged: true,
          recordFirstName: id.firstName,
          recordMiddleName: id.middleName,
          recordLastName: id.lastName,
          recordDateOfBirth: id.dateOfBirth,
          recordGender: id.gender,
          recordUsable: id.usable,
          providerCustomerRef: id.customerRef,
          match: match as unknown as Prisma.InputJsonValue,
          screeningId,
        },
      });
      if (r.count !== 1) return out;
      await tx.kycProfile.updateMany({ where: { userId }, data: { status: 'PENDING' } });
      await tx.user.updateMany({ where: { id: userId }, data: { kycStatus: 'PENDING' } });
      if (reviewReason) {
        await tx.kycVerification.updateMany({ where: { id: verificationId, state: 'LOOKED_UP' }, data: { state: 'IDENTITY_REVIEW', reviewReason } });
        out.push(() => this.mailUser(userId, 'kyc.submitted'));
      } else if (screeningId && !screeningIsNew) {
        // A reused screening may already be final: settle now.
        out.push(...(await this.aml.finalise(tx, screeningId)));
      }
      return out;
    });
    await runEffects(effects, this.log);

    // 4. AML, inline. Failures are recorded and retried by the recovery cron; never thrown here.
    if (screeningId && screeningIsNew) await this.aml.send(screeningId);

    const v = await this.prisma.kycVerification.findUniqueOrThrow({ where: { id: verificationId } });
    if (v.state === 'COMPLIANCE_REVIEW' || v.state === 'LOOKED_UP') await this.mailUser(userId, 'kyc.submitted');
    return this.respond(v.state);
  }

  private respond(state: KycVerificationState): BasicResponse {
    if (state === 'APPROVED') return { state, level: 'BASIC', message: MSG_APPROVED };
    if (state === 'REJECTED_NOT_FOUND') return { state, level: 'NONE', message: MSG_NOT_FOUND };
    return { state, level: 'NONE', message: MSG_REVIEW };
  }

  /** CREATED, under the per-user lock: attempt limits and the activeFor claim (spec §8.1, §8.2). */
  private async create(userId: string, input: BasicInput): Promise<string> {
    const today = lagosDate(new Date());
    // Read before the write: no extra round trip inside the locked step.
    const settings = await this.cfg.effective();
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'kyc.basic:' + userId}))`;
        const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
        // Final review C1: under review, restricted or blocked people never start a new verification.
        if (user.amlStatus !== 'NOT_SCREENED' && user.amlStatus !== 'CLEAR') throw new ForbiddenException(GATE_REVIEW);
        if (user.kycStatus === 'APPROVED' && user.kycTier !== 'TIER_0') throw new ConflictException('You are already verified.');

        // H8: one BVN/NIN verifies one account. Checked before the paid lookup,
        // and before anything is written, so a refusal costs nothing and is not
        // counted as an attempt.
        const idHash = this.hasher.hash(input.idNumber);
        const onProfile = input.idType === 'BVN' ? { bvnHash: idHash } : { ninHash: idHash };
        const [verifiedElsewhere, verifyingElsewhere] = await Promise.all([
          heldByOpenAccount(tx, userId, await tx.kycProfile.findMany({ where: { userId: { not: userId }, ...onProfile }, select: { userId: true } })),
          heldByOpenAccount(tx, userId, await tx.kycVerification.findMany({ where: { userId: { not: userId }, idHash, activeFor: { not: null } }, select: { userId: true } })),
        ]);
        if (verifiedElsewhere || verifyingElsewhere) throw new ConflictException(MSG_ID_IN_USE);

        const counted = { userId, state: { not: 'FAILED_SYSTEM' as const } };
        const [total, daily] = await Promise.all([
          tx.kycVerification.count({ where: counted }),
          tx.kycVerification.count({ where: { ...counted, lagosDay: today } }),
        ]);
        if (total >= settings.totalAttempts) throw new HttpException(MSG_TOTAL, HttpStatus.TOO_MANY_REQUESTS);
        if (daily >= settings.dailyAttempts) throw new HttpException(MSG_DAILY, HttpStatus.TOO_MANY_REQUESTS);

        const address = { ...input.address, stateOfOrigin: input.stateOfOrigin, country: input.country };
        const profile = {
          addressLine: input.address.street,
          city: input.address.city,
          state: input.address.state,
          lga: input.address.lga,
          postcode: input.address.postcode ?? null,
          stateOfOrigin: input.stateOfOrigin,
          country: 'NG',
          submittedAt: new Date(),
        };
        await tx.kycProfile.upsert({
          where: { userId },
          create: { userId, ...profile },
          update: { ...profile, rejectionReason: null },
        });
        const v = await tx.kycVerification.create({
          data: {
            userId,
            activeFor: userId,
            lagosDay: today,
            idType: input.idType,
            idHash,
            idLast4: input.idNumber.slice(-4),
            typedFirstName: input.firstName.trim(),
            typedMiddleName: input.middleName?.trim() || null,
            typedLastName: input.lastName.trim(),
            typedDateOfBirth: input.dateOfBirth,
            typedAddress: address as Prisma.InputJsonValue,
          },
        });
        return v.id;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictException(MSG_IN_PROGRESS);
      throw err;
    }
  }

  /**
   * LOOKED_UP / IDENTITY_REVIEW / COMPLIANCE_REVIEW → APPROVED, with every
   * user-visible consequence in the same transaction (spec §7.1).
   */
  async approve(tx: Tx, verificationId: string): Promise<Effect[]> {
    const v = await tx.kycVerification.findUniqueOrThrow({ where: { id: verificationId } });
    // Final review C1: only a person who is AML-CLEAR is ever approved. Anyone else
    // waits in COMPLIANCE_REVIEW and is approved when their last case is released.
    const holder = await tx.user.findUnique({ where: { id: v.userId }, select: { amlStatus: true } });
    if (holder?.amlStatus !== 'CLEAR') {
      const parked = await tx.kycVerification.updateMany({
        where: { id: v.id, state: { in: ['LOOKED_UP', 'IDENTITY_REVIEW'] } },
        data: { state: 'COMPLIANCE_REVIEW' },
      });
      if (parked.count === 1) {
        await tx.kycProfile.updateMany({ where: { userId: v.userId }, data: { status: 'PENDING' } });
        await tx.user.updateMany({ where: { id: v.userId }, data: { kycStatus: 'PENDING' } });
      }
      return [];
    }
    // H8: checked again at approval, for two accounts verifying the same
    // number at the same moment. The lookup is already paid for, so this rare
    // case waits for a person rather than being thrown away.
    const onProfile = v.idType === 'BVN' ? { bvnHash: v.idHash } : { ninHash: v.idHash };
    const elsewhere = await heldByOpenAccount(tx, v.userId, await tx.kycProfile.findMany({ where: { userId: { not: v.userId }, ...onProfile }, select: { userId: true } }));
    if (elsewhere) {
      await tx.kycVerification.updateMany({
        where: { id: v.id, state: { in: ['LOOKED_UP', 'COMPLIANCE_REVIEW'] } },
        data: { state: 'IDENTITY_REVIEW' },
      });
      this.log.warn(`Verification ${v.id}: this ID is already verified on another account; sent to identity review`);
      return [];
    }
    const r = await tx.kycVerification.updateMany({
      where: { id: v.id, state: { in: ['LOOKED_UP', 'IDENTITY_REVIEW', 'COMPLIANCE_REVIEW'] } },
      data: { state: 'APPROVED', activeFor: null },
    });
    if (r.count !== 1) return [];
    // The same fields and hash submitTier1 wrote, so opening a naira deposit account still works (spec §14.4).
    const hashFields = v.idType === 'BVN' ? { bvnHash: v.idHash, bvnLast4: v.idLast4 } : { ninHash: v.idHash, ninLast4: v.idLast4 };
    await tx.kycProfile.updateMany({
      where: { userId: v.userId },
      data: {
        ...hashFields,
        status: 'APPROVED',
        tier: 'TIER_1',
        dateOfBirth: v.recordDateOfBirth ? new Date(`${v.recordDateOfBirth}T00:00:00Z`) : undefined,
        providerName: 'dojah',
        providerRef: v.providerCustomerRef,
        reviewedAt: new Date(),
        rejectionReason: null,
      },
    });
    await tx.user.updateMany({ where: { id: v.userId }, data: { kycStatus: 'APPROVED', kycTier: 'TIER_1' } });
    // The tier rides in the JWT: revoking makes it take effect now (as reviewKyc does).
    await tx.refreshToken.updateMany({ where: { userId: v.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    return [() => this.mailUser(v.userId, 'kyc.approved'), () => this.referrals.onKycChanged(v.userId)];
  }

  /** Recovery for lookups (spec §14.5): never repeated, because the raw number is gone. */
  async failStaleLookups(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - LEASE_MS);
    const stale = await this.prisma.kycVerification.findMany({
      where: {
        state: 'CREATED',
        OR: [{ lookupOutcome: 'IN_FLIGHT', lookupStartedAt: { lt: cutoff } }, { lookupOutcome: null, createdAt: { lt: cutoff } }],
      },
      take: 100,
    });
    let n = 0;
    for (const v of stale) {
      const inFlight = v.lookupOutcome === 'IN_FLIGHT';
      const r = await this.prisma.kycVerification.updateMany({
        where: { id: v.id, state: 'CREATED', lookupOutcome: v.lookupOutcome },
        data: {
          state: 'FAILED_SYSTEM',
          activeFor: null,
          lookupOutcome: inFlight ? 'UNKNOWN' : null,
          possiblyCharged: inFlight,
          failureReason: inFlight ? 'LOOKUP_UNRECORDED' : 'NEVER_SENT',
        },
      });
      if (r.count === 1) {
        n++;
        if (inFlight) this.log.warn(`Verification ${v.id}: lookup outcome unknown after a crash (possiblyCharged)`);
      }
    }
    return n;
  }

  async attemptsLeft(userId: string): Promise<{ today: number; total: number }> {
    const counted = { userId, state: { not: 'FAILED_SYSTEM' as const } };
    const [total, daily] = await Promise.all([
      this.prisma.kycVerification.count({ where: counted }),
      this.prisma.kycVerification.count({ where: { ...counted, lagosDay: lagosDate(new Date()) } }),
    ]);
    const settings = await this.cfg.effective();
    return { today: Math.max(0, settings.dailyAttempts - daily), total: Math.max(0, settings.totalAttempts - total) };
  }

  private async mailUser(userId: string, key: 'kyc.submitted' | 'kyc.approved' | 'kyc.rejected', reason?: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, firstName: true, lastName: true } });
    if (!user) return;
    await this.mail.send({
      key,
      to: user.email,
      variables: { firstName: user.firstName, lastName: user.lastName, email: user.email, tier: 'BASIC', reason: reason ?? '' },
    });
  }
}

/**
 * H8 counts only accounts that are still open: a closed account (an owner
 * closed it, 28 Oct 2026) releases its BVN/NIN, so the same person can verify
 * a new account. A suspended account still holds it.
 */
async function heldByOpenAccount(
  tx: { user: { count: (a: { where: Record<string, unknown> }) => Promise<number> } },
  self: string,
  rows: Array<{ userId: string }>,
): Promise<boolean> {
  const others = [...new Set(rows.map((r) => r.userId))].filter((id) => id !== self);
  if (others.length === 0) return false;
  return (await tx.user.count({ where: { id: { in: others }, status: { not: 'CLOSED' } } })) > 0;
}
