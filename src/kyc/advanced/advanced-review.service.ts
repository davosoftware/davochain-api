import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { runEffects } from '../../compliance/aml.service';
import { lagosDate } from '../../common/dates';
import { AdvancedApprover } from './advanced-approver';
import { AdvancedRunner } from './advanced-runner.service';

export type ReviewRejectReason = 'DOC_UNCLEAR' | 'DOC_ALTERED' | 'NAME_MISMATCH' | 'ADDRESS_NOT_SHOWN' | 'NOT_ACCEPTED' | 'OTHER' | 'APPROVED_AFTER_REVIEW';
export const REVIEW_REASONS: readonly ReviewRejectReason[] = ['DOC_UNCLEAR', 'DOC_ALTERED', 'NAME_MISMATCH', 'ADDRESS_NOT_SHOWN', 'NOT_ACCEPTED', 'OTHER', 'APPROVED_AFTER_REVIEW'];

/** What the customer reads when an admin rejects (spec §8). "Other" shows the admin's note instead. */
export const REVIEW_REJECT_MESSAGES: Record<Exclude<ReviewRejectReason, 'OTHER' | 'APPROVED_AFTER_REVIEW'>, string> = {
  DOC_UNCLEAR: 'Your document was not clear enough to check. Please send a sharper photo.',
  DOC_ALTERED: 'We could not accept this document. Please send an original, unedited document.',
  NAME_MISMATCH: "The name on your document doesn't match your verified name.",
  ADDRESS_NOT_SHOWN: "Your address isn't shown on this document. Please send one that shows it.",
  NOT_ACCEPTED: "This kind of document isn't accepted. Please send one from the list in the app.",
};

/** Admins decide Advanced attempts a rule could not (spec 2026-10-21 §8). Audited in the same transaction. */
@Injectable()
export class AdvancedReviewService {
  private readonly log = new Logger(AdvancedReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly approver: AdvancedApprover,
    private readonly runner: AdvancedRunner,
  ) {}

  async list() {
    const startOfToday = new Date(`${lagosDate(new Date())}T00:00:00+01:00`);
    const [rows, approvedToday, rejectedToday] = await Promise.all([
      this.prisma.advancedVerification.findMany({ where: { state: 'IN_REVIEW' }, orderBy: { createdAt: 'asc' }, take: 100 }),
      this.prisma.advancedVerification.count({ where: { state: 'APPROVED', updatedAt: { gte: startOfToday } } }),
      this.prisma.advancedVerification.count({ where: { state: 'REJECTED', updatedAt: { gte: startOfToday } } }),
    ]);
    const out = [];
    for (const r of rows) {
      const ids = [r.frontDocumentId, r.backDocumentId, r.selfieDocumentId, r.addressDocumentId].filter((x): x is string => !!x);
      const [user, documents, verified] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: r.userId }, select: { id: true, firstName: true, lastName: true, email: true } }),
        this.prisma.kycDocument.findMany({ where: { id: { in: ids } }, select: { id: true, type: true, mimeType: true } }),
        this.runner.verified(r.userId),
      ]);
      out.push({
        id: r.id,
        step: r.step,
        createdAt: r.createdAt,
        user: user ? { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email } : null,
        idType: r.idType,
        addressKind: r.addressKind,
        documents: documents.map((d) => ({ id: d.id, type: d.type, mimeType: d.mimeType })),
        verified,
        findings: r.findings,
        reviewReasons: r.reviewReasons,
        docLast4: r.docLast4,
      });
    }
    return { waiting: rows.length, approvedToday, rejectedToday, rows: out };
  }

  async decide(actor: { adminId: string; ip?: string }, id: string, d: { approve: boolean; reason: ReviewRejectReason; note?: string }) {
    if (d.approve && d.reason !== 'APPROVED_AFTER_REVIEW') throw new BadRequestException('To approve, choose "Approved after review".');
    if (!d.approve && d.reason === 'APPROVED_AFTER_REVIEW') throw new BadRequestException('Choose why it is rejected.');
    const note = d.note?.trim() || null;
    if (!d.approve && d.reason === 'OTHER' && !note) throw new BadRequestException('Write the note the customer will see.');
    const nothing = () => new NotFoundException('Nothing is waiting for review with this id');

    const { state, effects } = await this.prisma.$transaction(async (tx) => {
      const v = await tx.advancedVerification.findFirst({ where: { id, state: 'IN_REVIEW' } });
      if (!v) throw nothing();
      const message = d.approve ? null : d.reason === 'OTHER' ? note! : REVIEW_REJECT_MESSAGES[d.reason as keyof typeof REVIEW_REJECT_MESSAGES];
      const effects = d.approve ? await this.approver.approve(tx, id) : await this.approver.reject(tx, id, 'BY_REVIEW', message!, 'IN_REVIEW');
      // Someone else decided it between our read and our write: nothing changed.
      if (!effects.length) throw nothing();
      const next = d.approve ? ('APPROVED' as const) : ('REJECTED' as const);
      await tx.advancedVerification.update({ where: { id }, data: { reviewedBy: actor.adminId, reviewedAt: new Date(), reviewNote: note } });
      await tx.adminAuditLog.create({
        data: {
          adminUserId: actor.adminId,
          action: d.approve ? 'kyc.advanced.approve' : 'kyc.advanced.reject',
          entity: 'AdvancedVerification',
          entityId: id,
          before: { state: v.state, step: v.step, reviewReasons: v.reviewReasons },
          after: { state: next, reason: d.reason, note } as Prisma.InputJsonValue,
          ip: actor.ip ?? null,
        },
      });
      return { state: next, effects };
    });
    await runEffects(effects, this.log);
    return { state };
  }
}
