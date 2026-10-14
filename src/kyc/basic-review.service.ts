import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { KycVerificationState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TemplatedMailService } from '../cms/templated-mail.service';
import { runEffects, type Effect } from '../compliance/aml.service';
import { BasicVerificationService } from './basic-verification.service';

/** A person decides an identity mismatch (spec §7.1, §10). Audited in the same transaction. */
@Injectable()
export class BasicReviewService {
  private readonly log = new Logger(BasicReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly basic: BasicVerificationService,
    private readonly mail: TemplatedMailService,
  ) {}

  async decide(
    actor: { adminId: string; ip?: string },
    userId: string,
    d: { approve: boolean; reason: string },
  ): Promise<{ state: KycVerificationState }> {
    const nothing = () => new NotFoundException('Nothing is waiting for identity review for this user');
    const { state, effects } = await this.prisma.$transaction(async (tx) => {
      const v = await tx.kycVerification.findFirst({ where: { userId, state: 'IDENTITY_REVIEW' }, orderBy: { createdAt: 'desc' } });
      if (!v) throw nothing();
      const s = v.screeningId ? await tx.amlScreening.findUnique({ where: { id: v.screeningId } }) : null;
      const out: Effect[] = [];
      let next: KycVerificationState;

      if (d.approve) {
        if (!s) throw new ConflictException('There is no verified identity to screen. Reject instead.');
        if (s.status === 'PENDING') throw new ConflictException('AML screening is still running. Try again in a few minutes.');
        // Clear, or a person already decided its AML case in the person's favour and
        // nothing else holds them (found in the live sandbox run: the case can be
        // decided before the identity is).
        const caseRow = await tx.amlReviewCase.findUnique({ where: { screeningId: s.id } });
        const user = await tx.user.findUnique({ where: { id: userId }, select: { amlStatus: true } });
        const amlSettled =
          s.status === 'CLEAR' ||
          (!!caseRow && ['CLEARED', 'PEP_APPROVED_EDD', 'SANCTIONS_FALSE_POSITIVE'].includes(caseRow.status) && user?.amlStatus === 'CLEAR');
        if (amlSettled) {
          out.push(...(await this.basic.approve(tx, v.id)));
          next = 'APPROVED';
        } else {
          const r = await tx.kycVerification.updateMany({ where: { id: v.id, state: 'IDENTITY_REVIEW' }, data: { state: 'COMPLIANCE_REVIEW' } });
          if (r.count !== 1) throw nothing();
          next = 'COMPLIANCE_REVIEW';
        }
      } else {
        const r = await tx.kycVerification.updateMany({
          where: { id: v.id, state: 'IDENTITY_REVIEW' },
          data: { state: 'REJECTED_BY_REVIEW', activeFor: null },
        });
        if (r.count !== 1) throw nothing();
        await tx.kycProfile.updateMany({ where: { userId }, data: { status: 'REJECTED', rejectionReason: d.reason } });
        await tx.user.updateMany({ where: { id: userId }, data: { kycStatus: 'REJECTED' } });
        out.push(() => this.mailUser(userId, d.reason));
        next = 'REJECTED_BY_REVIEW';
      }

      await tx.kycVerification.update({ where: { id: v.id }, data: { decidedBy: actor.adminId, decidedAt: new Date(), decisionReason: d.reason } });
      await tx.adminAuditLog.create({
        data: {
          adminUserId: actor.adminId,
          action: d.approve ? 'kyc.basic.approve' : 'kyc.basic.reject',
          entity: 'KycVerification',
          entityId: v.id,
          before: { state: v.state },
          after: { state: next, reason: d.reason },
          ip: actor.ip ?? null,
        },
      });
      return { state: next, effects: out };
    });
    await runEffects(effects, this.log);
    return { state };
  }

  private async mailUser(userId: string, reason: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, firstName: true, lastName: true } });
    if (!user) return;
    await this.mail.send({
      key: 'kyc.rejected',
      to: user.email,
      variables: { firstName: user.firstName, lastName: user.lastName, email: user.email, tier: 'BASIC', reason },
    });
  }
}
