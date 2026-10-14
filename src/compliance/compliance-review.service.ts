import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AlertType, type AmlCaseStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OpsAlertsService } from '../common/ops-alerts/ops-alerts.service';
import { AmlService, runEffects, VA_SWITCH, type Effect, type Tx, type VaSwitch } from './aml.service';
import { CASE_TRANSITIONS, allowed } from './aml-transitions';

export interface Actor {
  adminId: string;
  role: 'OWNER' | 'SUB_ADMIN';
  permissions: string[];
  ip?: string;
}

/** Narrow interface onto BasicVerificationService, to keep the module graph acyclic. */
export interface Approver {
  approve(tx: Tx, verificationId: string): Promise<Effect[]>;
}
export const APPROVER = Symbol('KYC_APPROVER');

export type Decision = 'CLEARED' | 'PEP_APPROVED_EDD' | 'RESTRICTED' | 'SANCTIONS_CONFIRMED' | 'SANCTIONS_FALSE_POSITIVE';
const RELEASING = new Set<AmlCaseStatus>(['CLEARED', 'PEP_APPROVED_EDD', 'SANCTIONS_FALSE_POSITIVE']);
const STILL_OPEN: AmlCaseStatus[] = ['OPEN', 'CLEARANCE_PROPOSED', 'RESTRICTED'];
const PRIORITY_ORDER = { CRITICAL: 0, HIGH: 1, NORMAL: 2 } as const;
const MAX_RESCREENS = 3;
const NOBODY_ELSE = 'Nobody else can confirm it yet: grant compliance.review to a second trusted admin.';

/**
 * Compliance review of AML cases (spec §9, §14.1; plan ruling 5). Every
 * decision is a compare-and-set audited in its own transaction; releasing a
 * possibly sanctioned person always takes two different people.
 */
@Injectable()
export class ComplianceReviewService {
  private readonly log = new Logger(ComplianceReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APPROVER) private readonly approver: Approver,
    private readonly aml: AmlService,
    @Inject(VA_SWITCH) private readonly virtualAccounts: VaSwitch,
    private readonly alerts: OpsAlertsService,
  ) {}

  async list(filter: 'open' | 'decided') {
    const rows = await this.prisma.amlReviewCase.findMany({
      where: { status: filter === 'open' ? { in: STILL_OPEN } : { notIn: STILL_OPEN } },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
      select: { id: true, firstName: true, lastName: true, email: true, amlStatus: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows
      .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.createdAt.getTime() - b.createdAt.getTime())
      .map((r) => ({
        id: r.id,
        status: r.status,
        category: r.category,
        priority: r.priority,
        possible: r.possible,
        riskLevel: r.riskLevel,
        createdAt: r.createdAt,
        proposedBy: r.proposedBy,
        user: byId.get(r.userId) ?? null,
      }));
  }

  /** The full case. Opening it is audited (spec §10). */
  async detail(actor: Actor, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const c = await tx.amlReviewCase.findUnique({ where: { id } });
      if (!c) throw new NotFoundException('Case not found');
      const user = await tx.user.findUnique({ where: { id: c.userId }, select: { id: true, firstName: true, lastName: true, email: true, amlStatus: true } });
      const screening = await tx.amlScreening.findUnique({ where: { id: c.screeningId } });
      const verification = await tx.kycVerification.findFirst({ where: { screeningId: c.screeningId }, orderBy: { createdAt: 'desc' } });
      await tx.adminAuditLog.create({
        data: { adminUserId: actor.adminId, action: 'aml.case.view', entity: 'AmlReviewCase', entityId: c.id, before: Prisma.JsonNull, after: Prisma.JsonNull, ip: actor.ip ?? null },
      });
      return {
        case: c,
        user,
        screening: screening && {
          status: screening.status,
          matchStatus: screening.matchStatus,
          riskLevel: screening.riskLevel,
          entityId: screening.entityId,
          inputs: screening.inputs,
          matches: screening.matches,
          sendCount: screening.sendCount,
          possibleDuplicateCharge: screening.possibleDuplicateCharge,
        },
        verification: verification && {
          idType: verification.idType,
          idLast4: verification.idLast4,
          typedFirstName: verification.typedFirstName,
          typedMiddleName: verification.typedMiddleName,
          typedLastName: verification.typedLastName,
          typedDateOfBirth: verification.typedDateOfBirth,
          recordFirstName: verification.recordFirstName,
          recordMiddleName: verification.recordMiddleName,
          recordLastName: verification.recordLastName,
          recordDateOfBirth: verification.recordDateOfBirth,
          recordGender: verification.recordGender,
        },
        eligibility: c.status === 'CLEARANCE_PROPOSED' ? await this.confirmEligibility(actor, c.proposedBy, tx) : { canConfirm: false, why: null },
      };
    });
  }

  async decide(actor: Actor, id: string, d: { decision: Decision; reason: string; reportedToAuthority?: boolean; reportReference?: string; reportedAt?: string }) {
    const { status, effects } = await this.prisma.$transaction(async (tx) => {
      const c = await tx.amlReviewCase.findUnique({ where: { id } });
      if (!c) throw new NotFoundException('Case not found');
      const sanctions = c.category === 'SANCTIONS';
      if (sanctions) {
        if (actor.role !== 'OWNER') throw new ForbiddenException('Only an owner can decide a sanctions case');
        if (d.decision !== 'SANCTIONS_CONFIRMED' && d.decision !== 'SANCTIONS_FALSE_POSITIVE') {
          throw new BadRequestException('A sanctions case is either confirmed or proposed as a false positive');
        }
      } else if (d.decision === 'SANCTIONS_CONFIRMED' || d.decision === 'SANCTIONS_FALSE_POSITIVE') {
        throw new BadRequestException('Sanctions decisions apply only to sanctions cases');
      }
      if (d.decision === 'SANCTIONS_CONFIRMED') {
        if (typeof d.reportedToAuthority !== 'boolean') throw new BadRequestException('Record whether this was reported to the authority');
        if (d.reportedToAuthority && (!d.reportReference || !d.reportedAt)) throw new BadRequestException('A report needs its reference and date');
      }

      const target: AmlCaseStatus = d.decision === 'SANCTIONS_FALSE_POSITIVE' ? 'CLEARANCE_PROPOSED' : d.decision;
      if (!allowed(CASE_TRANSITIONS, c.status, target)) throw new ConflictException('This case is not open for that decision');

      const now = new Date();
      const data: Prisma.AmlReviewCaseUpdateManyMutationInput =
        target === 'CLEARANCE_PROPOSED'
          ? { status: target, proposedBy: actor.adminId, proposedAt: now, proposalReason: d.reason }
          : {
              status: target,
              decidedBy: actor.adminId,
              decidedAt: now,
              reason: d.reason,
              ...(target === 'SANCTIONS_CONFIRMED'
                ? { reportedToAuthority: d.reportedToAuthority, reportReference: d.reportReference ?? null, reportedAt: d.reportedAt ? new Date(d.reportedAt) : null }
                : {}),
            };
      const moved = await tx.amlReviewCase.updateMany({ where: { id: c.id, status: c.status }, data });
      if (moved.count !== 1) throw new ConflictException('This case was decided by someone else just now');

      const out: Effect[] = [];
      if (target === 'RESTRICTED') await this.aml.setAmlStatus(tx, c.userId, 'RESTRICTED', ['UNDER_REVIEW']);
      if (target === 'SANCTIONS_CONFIRMED') {
        if (await this.aml.setAmlStatus(tx, c.userId, 'BLOCKED', ['PENDING', 'UNDER_REVIEW'])) {
          await tx.refreshToken.updateMany({ where: { userId: c.userId, revokedAt: null }, data: { revokedAt: now } });
          out.push(() => this.virtualAccounts.setDesiredForUser(c.userId, 'INACTIVE', { background: true }));
        }
      }
      if (RELEASING.has(target)) out.push(...(await this.release(tx, c.userId, c.screeningId, c.id)));
      if (target === 'CLEARANCE_PROPOSED') out.push(() => this.alert(c.id, 'proposed', 'Sanctions clearance proposed: a second admin must confirm'));

      await tx.adminAuditLog.create({
        data: {
          adminUserId: actor.adminId,
          action: target === 'CLEARANCE_PROPOSED' ? 'aml.case.propose_clearance' : 'aml.case.decide',
          entity: 'AmlReviewCase',
          entityId: c.id,
          before: { status: c.status },
          after: { status: target, reason: d.reason },
          ip: actor.ip ?? null,
        },
      });
      return { status: target, effects: out };
    });
    await runEffects(effects, this.log);
    return { status };
  }

  async confirm(actor: Actor, id: string, d: { confirm: boolean; reason: string }) {
    const { status, effects } = await this.prisma.$transaction(async (tx) => {
      const c = await tx.amlReviewCase.findUnique({ where: { id } });
      if (!c) throw new NotFoundException('Case not found');
      if (c.status !== 'CLEARANCE_PROPOSED') throw new ConflictException('There is no proposal to confirm');
      const elig = await this.confirmEligibility(actor, c.proposedBy, tx);
      if (!elig.canConfirm) throw new ForbiddenException(elig.why ?? 'You cannot confirm this proposal');

      const out: Effect[] = [];
      let target: AmlCaseStatus;
      const now = new Date();
      if (d.confirm) {
        target = 'SANCTIONS_FALSE_POSITIVE';
        // The DB CHECK (confirmedBy <> proposedBy) backs this up (spec §14.1).
        const r = await tx.amlReviewCase.updateMany({
          where: { id: c.id, status: 'CLEARANCE_PROPOSED', proposedBy: c.proposedBy },
          data: { status: target, confirmedBy: actor.adminId, confirmedAt: now, decidedBy: actor.adminId, decidedAt: now, reason: d.reason },
        });
        if (r.count !== 1) throw new ConflictException('This proposal changed just now');
        out.push(...(await this.release(tx, c.userId, c.screeningId, c.id)));
        out.push(() => this.virtualAccounts.setDesiredForUser(c.userId, 'ACTIVE', { background: true }));
        out.push(() => this.alert(c.id, 'confirmed', 'Sanctions clearance confirmed by a second admin'));
      } else {
        target = 'OPEN';
        const r = await tx.amlReviewCase.updateMany({
          where: { id: c.id, status: 'CLEARANCE_PROPOSED' },
          data: { status: 'OPEN', proposedBy: null, proposedAt: null, proposalReason: null },
        });
        if (r.count !== 1) throw new ConflictException('This proposal changed just now');
      }
      await tx.adminAuditLog.create({
        data: {
          adminUserId: actor.adminId,
          action: d.confirm ? 'aml.case.confirm' : 'aml.case.reject_proposal',
          entity: 'AmlReviewCase',
          entityId: c.id,
          before: { status: c.status, proposedBy: c.proposedBy },
          after: { status: target, reason: d.reason },
          ip: actor.ip ?? null,
        },
      });
      return { status: target, effects: out };
    });
    await runEffects(effects, this.log);
    return { status };
  }

  async withdraw(actor: Actor, id: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const c = await tx.amlReviewCase.findUnique({ where: { id } });
      if (!c || c.status !== 'CLEARANCE_PROPOSED') throw new ConflictException('There is no proposal to withdraw');
      if (c.proposedBy !== actor.adminId) throw new ForbiddenException('Only the person who proposed it can withdraw it');
      const r = await tx.amlReviewCase.updateMany({
        where: { id, status: 'CLEARANCE_PROPOSED', proposedBy: actor.adminId },
        data: { status: 'OPEN', proposedBy: null, proposedAt: null, proposalReason: null },
      });
      if (r.count !== 1) throw new ConflictException('This proposal changed just now');
      await tx.adminAuditLog.create({
        data: { adminUserId: actor.adminId, action: 'aml.case.withdraw_proposal', entity: 'AmlReviewCase', entityId: id, before: { status: c.status }, after: { status: 'OPEN', reason }, ip: actor.ip ?? null },
      });
      return { status: 'OPEN' as const };
    });
  }

  /** Plan ruling 5: only a case whose screening never produced a result; each one is a paid call. */
  async rescreen(actor: Actor, id: string, reason: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      const c = await tx.amlReviewCase.findUnique({ where: { id } });
      if (!c) throw new NotFoundException('Case not found');
      if (c.category !== 'ERROR' || !STILL_OPEN.includes(c.status)) {
        throw new ConflictException('Only an open case whose screening never produced a result can be re-screened');
      }
      if (c.rescreenCount >= MAX_RESCREENS) throw new ConflictException('This case has been re-screened 3 times. Decide it.');
      const r = await tx.amlScreening.updateMany({
        where: { id: c.screeningId, status: 'ERROR' },
        data: { status: 'PENDING', callOutcome: null, unknownCount: 0, definiteFailCount: 0, nextAttemptAt: null, lastError: null },
      });
      if (r.count !== 1) throw new ConflictException('A re-screen is already running');
      const n = c.rescreenCount + 1;
      await tx.amlReviewCase.update({ where: { id }, data: { rescreenCount: n } });
      await tx.adminAuditLog.create({
        data: { adminUserId: actor.adminId, action: 'aml.rescreen', entity: 'AmlReviewCase', entityId: id, before: { rescreenCount: c.rescreenCount }, after: { rescreenCount: n, reason }, ip: actor.ip ?? null },
      });
      return { rescreenCount: n, screeningId: c.screeningId };
    });
    // A paid call, after commit; its own claim stops duplicates.
    await this.aml.send(result.screeningId);
    return { rescreenCount: result.rescreenCount };
  }

  /**
   * Spec §14.1: never the proposer; another active owner; or, only when no
   * other active owner exists, an active admin holding compliance.review.
   */
  async confirmEligibility(actor: Actor, proposedBy: string | null, tx: Tx = this.prisma): Promise<{ canConfirm: boolean; why: string | null }> {
    if (!proposedBy) return { canConfirm: false, why: 'There is no proposal.' };
    const otherOwners = await tx.adminUser.count({ where: { role: 'OWNER', isActive: true, id: { not: proposedBy } } });
    if (actor.adminId === proposedBy) {
      const reviewers = otherOwners > 0 ? [] : await this.otherReviewers(tx, proposedBy);
      const why = 'You proposed this clearance, so a different admin must confirm it.';
      return { canConfirm: false, why: otherOwners === 0 && reviewers.length === 0 ? `${why} ${NOBODY_ELSE}` : why };
    }
    if (actor.role === 'OWNER') return { canConfirm: true, why: null };
    if (otherOwners > 0) return { canConfirm: false, why: 'Another owner exists, so an owner must confirm.' };
    if (!actor.permissions.includes('compliance.review')) return { canConfirm: false, why: 'You need compliance.review to confirm.' };
    return { canConfirm: true, why: null };
  }

  private async otherReviewers(tx: Tx, proposedBy: string): Promise<string[]> {
    const subs = await tx.adminUser.findMany({ where: { role: 'SUB_ADMIN', isActive: true, id: { not: proposedBy } }, select: { id: true, permissions: true } });
    return subs.filter((a) => a.permissions.includes('compliance.review')).map((a) => a.id);
  }

  /** The user goes CLEAR only when nothing else is open about them (spec §9; principle 3). */
  private async release(tx: Tx, userId: string, screeningId: string, caseId: string): Promise<Effect[]> {
    const others = await tx.amlReviewCase.count({ where: { userId, id: { not: caseId }, status: { in: STILL_OPEN } } });
    if (others > 0) return [];
    await this.aml.setAmlStatus(tx, userId, 'CLEAR', ['UNDER_REVIEW', 'RESTRICTED', 'BLOCKED']);
    const v = await tx.kycVerification.findFirst({ where: { screeningId, state: 'COMPLIANCE_REVIEW' } });
    return v ? this.approver.approve(tx, v.id) : [];
  }

  private async alert(caseId: string, step: string, subject: string): Promise<void> {
    await this.alerts.raise(AlertType.AML_SANCTIONS, `case:${caseId}:${step}`, subject, [`Case: ${caseId}`, `Open: /compliance/${caseId}`], 0);
  }
}
