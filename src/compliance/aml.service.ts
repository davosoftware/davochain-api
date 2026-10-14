import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AlertType, type AmlCaseCategory, type AmlCasePriority, type AmlStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DojahApi, type AmlInput } from '../dojah/dojah.client';
import { DojahError } from '../dojah/dojah.errors';
import { AML_BACKOFF_MS, LEASE_MS } from '../dojah/dojah.config';
import type { NormalisedIdentity } from '../dojah/dojah.types';
import { OpsAlertsService } from '../common/ops-alerts/ops-alerts.service';
import { SYSTEM_ACTOR_ID } from '../common/system-actor';
import { redactIds } from '../flutterwave/flutterwave.errors';
import { AML_STATUS_TRANSITIONS } from './aml-transitions';

export type Tx = PrismaService | Prisma.TransactionClient;
export type Effect = () => Promise<void>;
export type ApprovalHook = (tx: Tx, verificationId: string) => Promise<Effect[]>;

/**
 * Switching a person's naira deposit account on or off. The real one is
 * VirtualAccountsService, reached lazily (compliance.module.ts) because the
 * naira-deposit module already depends on the KYC module.
 */
export interface VaSwitch {
  setDesiredForUser(userId: string, desired: 'ACTIVE' | 'INACTIVE', opts?: { background?: boolean }): Promise<void>;
}
export const VA_SWITCH = Symbol('VA_SWITCH');

/** Things to do after a transaction commits, never inside it: an email or an HTTP call must not hold a row lock. */
export async function runEffects(effects: Effect[], log: Logger): Promise<void> {
  for (const e of effects) {
    try {
      await e();
    } catch (err) {
      log.error(`After-commit step failed: ${redactIds((err as Error).message)}`);
    }
  }
}

const MAX_DEFINITE_FAILURES = 1 + AML_BACKOFF_MS.length; // the first send plus three retries
const MAX_UNKNOWN = 2; // the first send plus one re-send (plan §R1.3)
const CONFIG_KINDS = new Set(['AUTH', 'IP', 'WALLET', 'BAD_REQUEST', 'CONFIG']);

/**
 * AML screening (spec §7.2, §8, §9): one screening per (user, inputs), every
 * paid call claimed before it is sent and recorded after, a case for anything
 * not CLEAR, and an automatic block for a confirmed sanctions match.
 */
@Injectable()
export class AmlService {
  private readonly log = new Logger(AmlService.name);
  private approvalHook: ApprovalHook = async () => [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly dojah: DojahApi,
    private readonly alerts: OpsAlertsService,
    @Inject(VA_SWITCH) private readonly virtualAccounts: VaSwitch,
  ) {}

  /** Registered by BasicVerificationService, which owns approval (no module cycle). */
  setApprovalHook(fn: ApprovalHook): void {
    this.approvalHook = fn;
  }

  /** Spec §14.3: verified names, date of birth, gender, nationality NG. Never an ID number. */
  amlInputs(identity: NormalisedIdentity): AmlInput | null {
    if (!identity.firstName || !identity.lastName) return null;
    const names = [identity.firstName, identity.middleName, identity.lastName].filter(Boolean).join(' ');
    const inputs: AmlInput = { names, nationality: 'NG' };
    if (identity.dateOfBirth) inputs.date_of_birth = identity.dateOfBirth;
    if (identity.gender === 'MALE') inputs.gender = 'Male';
    if (identity.gender === 'FEMALE') inputs.gender = 'Female';
    return inputs;
  }

  fingerprint(inputs: AmlInput): string {
    const record = inputs as unknown as Record<string, unknown>;
    const canonical = JSON.stringify(Object.keys(record).sort().map((k) => [k, record[k]]));
    return createHash('sha256').update(canonical).digest('hex');
  }

  /** One screening per (user, inputs): an existing one is reused, never re-bought (spec §8.3). */
  async startScreening(tx: Tx, userId: string, inputs: AmlInput): Promise<{ id: string; reused: boolean }> {
    const inputFingerprint = this.fingerprint(inputs);
    const existing = await tx.amlScreening.findUnique({ where: { userId_inputFingerprint: { userId, inputFingerprint } } });
    if (existing) return { id: existing.id, reused: true };
    const created = await tx.amlScreening.create({
      data: { userId, inputs: inputs as unknown as Prisma.InputJsonValue, inputFingerprint },
    });
    await this.setAmlStatus(tx, userId, 'PENDING', ['NOT_SCREENED', 'CLEAR']);
    return { id: created.id, reused: false };
  }

  /** Compare-and-set on the user's AML status, limited to the transition table. */
  async setAmlStatus(tx: Tx, userId: string, to: AmlStatus, from: readonly AmlStatus[]): Promise<boolean> {
    const legal = from.filter((f) => AML_STATUS_TRANSITIONS[f].includes(to));
    if (legal.length === 0) return false;
    const r = await tx.user.updateMany({ where: { id: userId, amlStatus: { in: legal } }, data: { amlStatus: to } });
    return r.count === 1;
  }

  /**
   * Claim, call, record (plan §R1.4). Safe to call from anywhere, any number
   * of times: only the caller that wins the claim sends, and only while the
   * retry budget and timing allow. Never throws for a Dojah failure.
   */
  async send(screeningId: string): Promise<void> {
    const s = await this.prisma.amlScreening.findUnique({ where: { id: screeningId } });
    if (!s || s.status !== 'PENDING' || s.callOutcome === 'IN_FLIGHT') return;
    if (s.nextAttemptAt && s.nextAttemptAt.getTime() > Date.now()) return;
    if (s.unknownCount >= MAX_UNKNOWN || s.definiteFailCount >= MAX_DEFINITE_FAILURES) return;

    // The claim: whoever moves sendCount from n to n+1 sends; everyone else stops.
    const claimed = await this.prisma.amlScreening.updateMany({
      where: { id: s.id, status: 'PENDING', sendCount: s.sendCount, callOutcome: s.callOutcome },
      data: {
        callOutcome: 'IN_FLIGHT',
        screenStartedAt: new Date(),
        sendCount: { increment: 1 },
        possibleDuplicateCharge: s.possibleDuplicateCharge || s.unknownCount > 0,
      },
    });
    if (claimed.count !== 1) return;
    const sendNo = s.sendCount + 1;

    let effects: Effect[];
    try {
      const result = await this.dojah.screen(s.inputs as unknown as AmlInput, s.id);
      effects = await this.prisma.$transaction(async (tx) => {
        const recorded = await tx.amlScreening.updateMany({
          where: { id: s.id, status: 'PENDING', sendCount: sendNo },
          data: {
            status: result.parsed.status,
            matchStatus: result.parsed.matchStatus,
            riskLevel: result.parsed.riskLevel,
            entityId: result.parsed.entityId,
            matches: result.parsed.matches as unknown as Prisma.InputJsonValue,
            category: result.parsed.category,
            callOutcome: 'SUCCEEDED',
            screenCompletedAt: new Date(),
            nextAttemptAt: null,
            lastError: null,
          },
        });
        if (recorded.count !== 1) return [];
        return this.finalise(tx, s.id);
      });
    } catch (err) {
      const e = err instanceof DojahError ? err : new DojahError('UNKNOWN', (err as Error).message, 0);
      effects = await this.recordFailure(s.id, sendNo, e);
    }
    await runEffects(effects, this.log);
  }

  private async recordFailure(id: string, sendNo: number, e: DojahError): Promise<Effect[]> {
    return this.prisma.$transaction(async (tx) => {
      const s = await tx.amlScreening.findUniqueOrThrow({ where: { id } });
      if (s.status !== 'PENDING' || s.sendCount !== sendNo) return [];
      const effects: Effect[] = [];
      if (e.definitelyFailed) {
        const n = s.definiteFailCount + 1;
        const exhausted = n >= MAX_DEFINITE_FAILURES;
        await tx.amlScreening.updateMany({
          where: { id, status: 'PENDING', sendCount: sendNo },
          data: {
            callOutcome: 'DEFINITELY_FAILED',
            definiteFailCount: n,
            lastError: e.message.slice(0, 300),
            status: exhausted ? 'ERROR' : 'PENDING',
            nextAttemptAt: exhausted ? null : new Date(Date.now() + AML_BACKOFF_MS[n - 1]),
          },
        });
        if (CONFIG_KINDS.has(e.kind)) {
          effects.push(async () => {
            await this.alerts.raise(AlertType.DOJAH_CONFIG, `dojah:${e.kind}`, 'Dojah refused an AML screen', [e.message]);
          });
        }
        if (exhausted) effects.push(...(await this.finalise(tx, id)));
      } else {
        const n = s.unknownCount + 1;
        const exhausted = n >= MAX_UNKNOWN;
        await tx.amlScreening.updateMany({
          where: { id, status: 'PENDING', sendCount: sendNo },
          data: {
            callOutcome: 'UNKNOWN',
            unknownCount: n,
            lastError: e.message.slice(0, 300),
            status: exhausted ? 'ERROR' : 'PENDING',
            nextAttemptAt: exhausted ? null : new Date((s.screenStartedAt ?? new Date()).getTime() + LEASE_MS),
          },
        });
        if (exhausted) effects.push(...(await this.finalise(tx, id)));
      }
      return effects;
    });
  }

  /**
   * For a screening whose status is final: the user's AML status, the case,
   * and every verification waiting on it (spec §7.2, §9). Idempotent.
   */
  async finalise(tx: Tx, screeningId: string): Promise<Effect[]> {
    const s = await tx.amlScreening.findUniqueOrThrow({ where: { id: screeningId } });
    if (s.status === 'PENDING') return [];
    const effects: Effect[] = [];

    if (s.status === 'CLEAR') {
      await this.setAmlStatus(tx, s.userId, 'CLEAR', ['PENDING']);
      // An old open case still holds UNDER_REVIEW; only a person lifts that (principle 3).
    } else {
      const sanctions = s.category === 'SANCTIONS';
      const confirmedSanctions = sanctions && s.status === 'CONFIRMED_MATCH';
      const category: AmlCaseCategory = s.status === 'ERROR' ? 'ERROR' : ((s.category as AmlCaseCategory | null) ?? 'UNKNOWN');
      const priority: AmlCasePriority = sanctions ? 'CRITICAL' : category === 'PEP' || category === 'ADVERSE_MEDIA' ? 'HIGH' : 'NORMAL';

      const existing = await tx.amlReviewCase.findUnique({ where: { screeningId } });
      const caseRow =
        existing ??
        (await tx.amlReviewCase.create({
          data: {
            userId: s.userId,
            screeningId,
            category,
            priority,
            possible: sanctions && !confirmedSanctions,
            riskLevel: s.riskLevel,
            entityId: s.entityId,
            matches: (s.matches ?? undefined) as Prisma.InputJsonValue | undefined,
          },
        }));

      if (confirmedSanctions) {
        const blocked = await this.setAmlStatus(tx, s.userId, 'BLOCKED', ['PENDING', 'UNDER_REVIEW']);
        if (blocked) {
          await tx.refreshToken.updateMany({ where: { userId: s.userId, revokedAt: null }, data: { revokedAt: new Date() } });
          await tx.adminAuditLog.create({
            data: {
              adminUserId: SYSTEM_ACTOR_ID,
              action: 'aml.auto_block',
              entity: 'AmlReviewCase',
              entityId: caseRow.id,
              before: Prisma.JsonNull,
              after: { amlStatus: 'BLOCKED' },
            },
          });
          effects.push(() => this.virtualAccounts.setDesiredForUser(s.userId, 'INACTIVE', { background: true }));
        }
      } else {
        await this.setAmlStatus(tx, s.userId, 'UNDER_REVIEW', ['PENDING']);
      }

      if (!existing) {
        const type = sanctions ? AlertType.AML_SANCTIONS : AlertType.AML_REVIEW;
        const label = confirmedSanctions
          ? 'Confirmed sanctions match: account blocked'
          : sanctions
            ? 'Possible sanctions match'
            : 'AML review needed';
        // Keyed per case with no cooldown, so the hourly duplicate rule never swallows one (spec §9.2).
        // Carries no name: an inbox is not a compliance record.
        effects.push(async () => {
          await this.alerts.raise(
            type,
            `case:${caseRow.id}`,
            label,
            [`Case: ${caseRow.id}`, `Category: ${category}`, `Risk: ${s.riskLevel ?? 'not given'}`, `Open: /compliance/${caseRow.id}`],
            0,
          );
        });
      }
    }

    // Verifications whose identity is accepted and which waited on this screening.
    const waiting = await tx.kycVerification.findMany({ where: { screeningId, state: 'LOOKED_UP' } });
    for (const v of waiting) {
      if (s.status === 'CLEAR') {
        effects.push(...(await this.approvalHook(tx, v.id)));
      } else {
        const moved = await tx.kycVerification.updateMany({ where: { id: v.id, state: 'LOOKED_UP' }, data: { state: 'COMPLIANCE_REVIEW' } });
        if (moved.count === 1) {
          await tx.kycProfile.updateMany({ where: { userId: v.userId }, data: { status: 'PENDING' } });
          await tx.user.updateMany({ where: { id: v.userId }, data: { kycStatus: 'PENDING' } });
        }
      }
    }
    return effects;
  }

  /** Recovery (plan §R1.4.4): IN_FLIGHT past the lease is UNKNOWN. */
  async markStaleInFlight(now = new Date()): Promise<number> {
    const stale = await this.prisma.amlScreening.findMany({
      where: { callOutcome: 'IN_FLIGHT', status: 'PENDING', screenStartedAt: { lt: new Date(now.getTime() - LEASE_MS) } },
      take: 100,
    });
    let n = 0;
    for (const s of stale) {
      const effects = await this.prisma.$transaction(async (tx) => {
        const next = s.unknownCount + 1;
        const exhausted = next >= MAX_UNKNOWN;
        const r = await tx.amlScreening.updateMany({
          where: { id: s.id, callOutcome: 'IN_FLIGHT', sendCount: s.sendCount, status: 'PENDING' },
          data: {
            callOutcome: 'UNKNOWN',
            unknownCount: next,
            lastError: 'No result recorded before the lease ran out',
            status: exhausted ? 'ERROR' : 'PENDING',
            nextAttemptAt: exhausted ? null : now,
          },
        });
        if (r.count !== 1) return [];
        n++;
        this.log.warn(`AML screening ${s.id}: outcome unknown after a crash; possibleDuplicateCharge on any re-send`);
        return exhausted ? this.finalise(tx, s.id) : [];
      });
      await runEffects(effects, this.log);
    }
    return n;
  }

  async dueRetries(now = new Date()): Promise<string[]> {
    const due = await this.prisma.amlScreening.findMany({
      where: { status: 'PENDING', callOutcome: { in: ['DEFINITELY_FAILED', 'UNKNOWN'] }, nextAttemptAt: { lte: now } },
      orderBy: { nextAttemptAt: 'asc' },
      take: 50,
    });
    return due.map((s) => s.id);
  }
}
