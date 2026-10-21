import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AdvancedStep, KycDocumentType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DojahConfig } from '../../dojah/dojah.config';
import { JOBS, QUEUES, jobId } from '../../common/queues';
import { lagosDate } from '../../common/dates';
import { GATE_REVIEW } from '../../auth/jwt-auth.guard';
import { MSG_UNAVAILABLE, READINESS, type Readiness } from '../basic-verification.service';
import type { AddressKindName, AdvancedIdTypeName } from './advanced.types';

export const MSG_ADV_DISABLED = "Advanced verification isn't available right now.";
export const MSG_ADV_IN_PROGRESS = 'A check is already in progress.';
export const MSG_ADV_DAILY = "You've used today's attempts. Try again tomorrow.";
export const MSG_ADV_TOTAL = "You've used all your verification attempts. Contact support.";
export const MSG_NEED_BASIC = 'Complete Basic verification first.';
export const MSG_NEED_IDENTITY = 'Complete your ID and selfie check first.';
export const MSG_NEED_RECORD = 'We need to check your Basic details before Advanced. Please contact support.';

const FRONT_TYPE: Record<AdvancedIdTypeName, KycDocumentType> = {
  NATIONAL_ID: KycDocumentType.NATIONAL_ID,
  PASSPORT: KycDocumentType.PASSPORT,
  DRIVERS_LICENSE: KycDocumentType.DRIVERS_LICENSE,
};

type StepState = 'NONE' | 'CHECKING' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'FAILED';
export interface StepSummary {
  state: StepState;
  reason: string | null;
  attemptsLeft: { today: number; total: number };
}
export interface AdvancedSummary {
  identity: StepSummary;
  address: StepSummary;
  recencyMonths: number;
}
/** field name in the request, document id, the type it must be, and whether a PDF is refused. */
type DocCheck = [field: string, id: string | undefined, type: KycDocumentType, imageOnly: boolean];

/**
 * Advanced verification, the request half (spec 2026-10-21 §4): every check that
 * costs nothing runs here, then one row and one queued job. The paid Dojah calls
 * run in AdvancedRunner, off the request, so a dropped phone never loses a result.
 */
@Injectable()
export class AdvancedVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: DojahConfig,
    @InjectQueue(QUEUES.KYC_ADVANCED) private readonly queue: Queue,
    @Optional() @Inject(READINESS) private readonly readiness?: Readiness,
  ) {}

  async submitIdentity(userId: string, i: { idType: AdvancedIdTypeName; frontDocumentId: string; backDocumentId?: string; selfieDocumentId: string }) {
    if (i.idType === 'PASSPORT' && i.backDocumentId) throw new BadRequestException('A passport has no back page: leave backDocumentId out');
    if (i.idType === 'NATIONAL_ID' && !i.backDocumentId) throw new BadRequestException('backDocumentId is required for a national ID card');
    const docs: DocCheck[] = [
      ['frontDocumentId', i.frontDocumentId, FRONT_TYPE[i.idType], true],
      ['backDocumentId', i.backDocumentId, KycDocumentType.ID_BACK, true],
      ['selfieDocumentId', i.selfieDocumentId, KycDocumentType.SELFIE, true],
    ];
    return this.start(userId, AdvancedStep.IDENTITY, docs, {
      idType: i.idType,
      frontDocumentId: i.frontDocumentId,
      backDocumentId: i.backDocumentId ?? null,
      selfieDocumentId: i.selfieDocumentId,
    });
  }

  /** Any ONE document of the customer's choice (spec D5): none of the kinds is compulsory. */
  async submitAddress(userId: string, i: { kind: AddressKindName; documentId: string }) {
    return this.start(userId, AdvancedStep.ADDRESS, [['documentId', i.documentId, KycDocumentType.PROOF_OF_ADDRESS, false]], {
      addressKind: i.kind,
      addressDocumentId: i.documentId,
    });
  }

  private async start(
    userId: string,
    step: AdvancedStep,
    docs: DocCheck[],
    data: Partial<Prisma.AdvancedVerificationUncheckedCreateInput>,
  ): Promise<{ verificationId: string; state: 'CHECKING' }> {
    const settings = await this.cfg.effective();
    if (!settings.advancedEnabled) throw new ServiceUnavailableException(MSG_ADV_DISABLED);
    try {
      await this.readiness?.assertReady();
    } catch {
      throw new ServiceUnavailableException(MSG_UNAVAILABLE);
    }
    const today = lagosDate(new Date());

    let id: string;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        // One submit per customer at a time from here; the activeFor unique is the backstop.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'kyc.advanced:' + userId}))`;
        const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { kycTier: true, kycStatus: true, amlStatus: true } });
        if (user.amlStatus !== 'CLEAR') throw new ForbiddenException(GATE_REVIEW);
        const approved = user.kycStatus === 'APPROVED';
        if (step === AdvancedStep.IDENTITY) {
          if (approved && (user.kycTier === 'TIER_2' || user.kycTier === 'TIER_3')) throw new ConflictException('Your ID and selfie are already verified.');
          if (!approved || user.kycTier !== 'TIER_1') throw new ForbiddenException(MSG_NEED_BASIC);
        } else {
          if (approved && user.kycTier === 'TIER_3') throw new ConflictException('You are already fully verified.');
          if (!approved || user.kycTier !== 'TIER_2') throw new ForbiddenException(MSG_NEED_IDENTITY);
        }

        // Advanced compares against the verified Basic record: without one, a person must sort it out first.
        const basic = await tx.kycVerification.findFirst({
          where: { userId, state: 'APPROVED', recordFirstName: { not: null }, recordLastName: { not: null }, recordDateOfBirth: { not: null } },
          select: { id: true },
        });
        if (!basic) throw new ForbiddenException(MSG_NEED_RECORD);

        // A check that failed on our side (FAILED_SYSTEM) is never counted against the customer.
        const counted = { userId, step, state: { not: 'FAILED_SYSTEM' as const } };
        const [total, daily] = await Promise.all([
          tx.advancedVerification.count({ where: counted }),
          tx.advancedVerification.count({ where: { ...counted, lagosDay: today } }),
        ]);
        if (total >= settings.advancedTotalAttempts) throw new HttpException(MSG_ADV_TOTAL, HttpStatus.FORBIDDEN);
        if (daily >= settings.advancedDailyAttempts) throw new HttpException(MSG_ADV_DAILY, HttpStatus.TOO_MANY_REQUESTS);

        for (const [field, docId, type, imageOnly] of docs) {
          if (!docId) continue;
          const d = await tx.kycDocument.findFirst({
            where: { id: docId, profile: { userId } },
            select: { type: true, mimeType: true, serverStored: true, status: true },
          });
          // Someone else's document and one from before secure storage read the same: not found.
          if (!d || !d.serverStored) throw new BadRequestException(`${field} was not found`);
          if (d.type !== type) throw new BadRequestException(`${field} must be a ${type} upload`);
          if (d.status !== 'PENDING') throw new BadRequestException(`${field} was already used in a decided check: upload it again`);
          if (imageOnly && d.mimeType === 'application/pdf') throw new BadRequestException(`${field} must be a photo, not a PDF`);
        }

        const row = await tx.advancedVerification.create({
          data: { userId, step, activeFor: userId, lagosDay: today, ...data } as Prisma.AdvancedVerificationUncheckedCreateInput,
        });
        return row.id;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictException(MSG_ADV_IN_PROGRESS);
      throw err;
    }
    // If this fails, the recovery sweep queues the row within minutes.
    await this.enqueue(id).catch(() => undefined);
    return { verificationId: id, state: 'CHECKING' };
  }

  /** The suffix lets the recovery sweep queue a row again after an earlier job with the plain id finished. */
  async enqueue(id: string, suffix?: string): Promise<void> {
    await this.queue.add(JOBS.RUN_ADVANCED, { id }, { jobId: suffix ? jobId('adv', id, suffix) : jobId('adv', id) });
  }

  async summary(userId: string): Promise<AdvancedSummary> {
    const settings = await this.cfg.effective();
    const today = lagosDate(new Date());
    const one = async (step: AdvancedStep): Promise<StepSummary> => {
      const counted = { userId, step, state: { not: 'FAILED_SYSTEM' as const } };
      const [latest, total, daily] = await Promise.all([
        this.prisma.advancedVerification.findFirst({ where: { userId, step }, orderBy: { createdAt: 'desc' }, select: { state: true, customerMessage: true } }),
        this.prisma.advancedVerification.count({ where: counted }),
        this.prisma.advancedVerification.count({ where: { ...counted, lagosDay: today } }),
      ]);
      const state: StepState = !latest ? 'NONE' : latest.state === 'FAILED_SYSTEM' ? 'FAILED' : latest.state;
      return {
        state,
        reason: latest && ['IN_REVIEW', 'REJECTED', 'FAILED_SYSTEM'].includes(latest.state) ? latest.customerMessage : null,
        attemptsLeft: {
          today: Math.max(0, settings.advancedDailyAttempts - daily),
          total: Math.max(0, settings.advancedTotalAttempts - total),
        },
      };
    };
    const [identity, address] = await Promise.all([one(AdvancedStep.IDENTITY), one(AdvancedStep.ADDRESS)]);
    return { identity, address, recencyMonths: settings.addressRecencyMonths };
  }
}
