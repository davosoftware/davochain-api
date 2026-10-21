import { Injectable } from '@nestjs/common';
import type { KycTier } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { Effect, Tx } from '../../compliance/aml.service';
import { TemplatedMailService } from '../../cms/templated-mail.service';
import { ReferralsService } from '../../referrals/referrals.service';
import { LEVEL_NAMES } from '../../levels/levels';
import type { RejectCode } from './advanced.types';

type DocRefs = { frontDocumentId: string | null; backDocumentId: string | null; selfieDocumentId: string | null; addressDocumentId: string | null };
const docIds = (v: DocRefs) => [v.frontDocumentId, v.backDocumentId, v.selfieDocumentId, v.addressDocumentId].filter((x): x is string => !!x);

/**
 * The one place an Advanced attempt is decided (spec 2026-10-21 §6, §8).
 * Always inside the caller's transaction, always a compare-and-set, so an
 * automatic decision and a person's can never both land.
 */
@Injectable()
export class AdvancedApprover {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: TemplatedMailService,
    private readonly referrals: ReferralsService,
  ) {}

  /** `from`: CHECKING for the automatic path, IN_REVIEW for a person (spec §6, §8). */
  async approve(tx: Tx, id: string, from: 'CHECKING' | 'IN_REVIEW'): Promise<Effect[]> {
    const v = await tx.advancedVerification.findUniqueOrThrow({ where: { id } });
    const [fromTier, to]: [KycTier, KycTier] = v.step === 'IDENTITY' ? ['TIER_1', 'TIER_2'] : ['TIER_2', 'TIER_3'];
    const r = await tx.advancedVerification.updateMany({
      where: { id, state: from },
      data: { state: 'APPROVED', activeFor: null, customerMessage: null },
    });
    if (r.count !== 1) return [];
    // Only ever one level up, from the level this step starts at: never lowers a level set some other way.
    await tx.kycProfile.updateMany({ where: { userId: v.userId, tier: fromTier }, data: { tier: to, status: 'APPROVED', reviewedAt: new Date(), rejectionReason: null } });
    await tx.user.updateMany({ where: { id: v.userId, kycTier: fromTier }, data: { kycTier: to, kycStatus: 'APPROVED' } });
    await tx.kycDocument.updateMany({ where: { id: { in: docIds(v) } }, data: { status: 'APPROVED', reviewedAt: new Date() } });
    // The tier rides in the JWT; revoking makes the new level apply now (as Basic approval does).
    await tx.refreshToken.updateMany({ where: { userId: v.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    return [() => this.mailUser(v.userId, 'kyc.approved', LEVEL_NAMES[to]), () => this.referrals.onKycChanged(v.userId)];
  }

  /** A rejection never touches the customer's existing level: an Advanced "no" leaves Basic in place. */
  async reject(tx: Tx, id: string, code: RejectCode, message: string, from: 'CHECKING' | 'IN_REVIEW'): Promise<Effect[]> {
    const v = await tx.advancedVerification.findUniqueOrThrow({ where: { id } });
    const r = await tx.advancedVerification.updateMany({
      where: { id, state: from },
      data: { state: 'REJECTED', activeFor: null, rejectCode: code, customerMessage: message },
    });
    if (r.count !== 1) return [];
    await tx.kycDocument.updateMany({ where: { id: { in: docIds(v) } }, data: { status: 'REJECTED', rejectionReason: message, reviewedAt: new Date() } });
    const level = v.step === 'IDENTITY' ? LEVEL_NAMES.TIER_2 : LEVEL_NAMES.TIER_3;
    return [() => this.mailUser(v.userId, 'kyc.rejected', level, message)];
  }

  private async mailUser(userId: string, key: 'kyc.approved' | 'kyc.rejected', tier: string, reason = ''): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, firstName: true, lastName: true } });
    if (!user) return;
    await this.mail.send({ key, to: user.email, variables: { firstName: user.firstName, lastName: user.lastName, email: user.email, tier, reason } });
  }
}
