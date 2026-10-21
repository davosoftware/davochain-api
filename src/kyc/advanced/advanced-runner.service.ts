import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AlertType, Prisma, type AdvancedVerification, type DojahCallOutcome } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DojahApi } from '../../dojah/dojah.client';
import { DojahConfig, LEASE_MS, type DojahSettings } from '../../dojah/dojah.config';
import { DojahError } from '../../dojah/dojah.errors';
import { FILE_STORE, type FileStore } from '../../storage/file-store';
import { KycHashService } from '../kyc-hash';
import { lagosDate } from '../../common/dates';
import { runEffects } from '../../compliance/aml.service';
import { OpsAlertsService } from '../../common/ops-alerts/ops-alerts.service';
import { SYSTEM_ACTOR_ID } from '../../common/system-actor';
import { READINESS, type Readiness } from '../basic-verification.service';
import { AdvancedApprover } from './advanced-approver';
import { AdvancedVerificationService } from './advanced-verification.service';
import { decideAddress, decideIdentity, summariseBill, summariseText } from './rules';
import {
  MSG_FAILED_SYSTEM,
  MSG_IN_REVIEW,
  REJECT_MESSAGES,
  tooOldMessage,
  type AddressEvidence,
  type Decision,
  type IdRead,
  type LivenessRead,
  type MatchRead,
  type Verified,
} from './advanced.types';

/** Another worker holds a call inside its lease: let BullMQ try again later. */
export class BusyError extends Error {
  constructor(id: string) {
    super(`Advanced ${id}: a call is in flight elsewhere`);
    this.name = 'BusyError';
  }
}
/** The attempt was ended (FAILED_SYSTEM or decided): the job is finished, not failed. */
class Stopped extends Error {}

type Call = 'read' | 'liveness' | 'match' | 'address';
const COL = (c: Call) => ({ outcome: `${c}Outcome`, started: `${c}StartedAt`, sends: `${c}Sends`, http: `${c}HttpStatus` }) as const;
/** Configuration failures: retrying cannot help, and ops must know. */
const STOP_KINDS = new Set(['WALLET', 'AUTH', 'IP', 'CONFIG']);

/** What is kept from an attempt (spec §5.2): never the portrait, a full document number, or document text. */
export interface Findings {
  id?: IdRead;
  readAgain?: boolean;
  liveness?: LivenessRead;
  match?: MatchRead;
  noPortrait?: boolean;
  address?: AddressEvidence;
  linkShared?: boolean;
}

/**
 * Runs one Advanced attempt (spec 2026-10-21 §6). Every paid call is claimed
 * (its own commit), sent, then recorded, so a crash resumes without repeating a
 * call that succeeded. The one exception is written down: the ID portrait is
 * never stored, so a crash between "read ID" and "face match" costs one re-read.
 */
@Injectable()
export class AdvancedRunner {
  private readonly log = new Logger(AdvancedRunner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dojah: DojahApi,
    private readonly cfg: DojahConfig,
    @Inject(FILE_STORE) private readonly files: FileStore,
    private readonly hasher: KycHashService,
    private readonly approver: AdvancedApprover,
    private readonly alerts: OpsAlertsService,
    private readonly submitter: AdvancedVerificationService,
    @Optional() @Inject(READINESS) private readonly readiness?: Readiness,
  ) {}

  async run(id: string): Promise<void> {
    const v = await this.prisma.advancedVerification.findUnique({ where: { id } });
    if (!v || v.state !== 'CHECKING') return;
    const settings = await this.cfg.effective();
    try {
      if (v.step === 'IDENTITY') await this.runIdentity(v, settings);
      else await this.runAddress(v, settings);
    } catch (err) {
      if (err instanceof Stopped) return;
      throw err;
    }
  }

  /** The verified Basic record and the address typed at Basic: what Advanced is compared with. */
  async verified(userId: string): Promise<Verified> {
    const [basic, profile] = await Promise.all([
      this.prisma.kycVerification.findFirst({ where: { userId, state: 'APPROVED' }, orderBy: { createdAt: 'desc' } }),
      this.prisma.kycProfile.findUnique({ where: { userId }, select: { addressLine: true, city: true, state: true } }),
    ]);
    if (!basic?.recordFirstName || !basic.recordLastName || !basic.recordDateOfBirth) throw new Error(`No verified Basic record for user ${userId}`);
    return {
      firstName: basic.recordFirstName,
      middleName: basic.recordMiddleName,
      lastName: basic.recordLastName,
      dateOfBirth: basic.recordDateOfBirth,
      address: { street: profile?.addressLine ?? null, city: profile?.city ?? null, state: profile?.state ?? null },
    };
  }

  private async runIdentity(v: AdvancedVerification, s: DojahSettings): Promise<void> {
    const verified = await this.verified(v.userId);
    const today = lagosDate(new Date());
    const t = { livenessMin: s.livenessMin, faceMatchPass: s.faceMatchPass, faceMatchReview: s.faceMatchReview };
    const idType = v.idType!;
    // Read every file first: a storage outage retries before anything is paid.
    const [front, back, selfie] = await Promise.all([
      this.base64(v.frontDocumentId!),
      v.backDocumentId ? this.base64(v.backDocumentId) : Promise.resolve(undefined),
      this.base64(v.selfieDocumentId!),
    ]);
    const f: Findings = { ...(v.findings as Findings) };
    // A call recorded as done whose result never got saved (a crash in between): a person decides.
    const system = () => this.finish(v.id, { outcome: 'REVIEW', reasons: ['SYSTEM'] }, f, s);
    let portrait: string | null = null;
    let readThisRun = false;
    const readId = async (again: boolean) => {
      try {
        return await this.paid(v.id, 'read', () => this.dojah.readId({ idType, front, back }), again);
      } catch (err) {
        if (err instanceof DojahError && err.kind === 'UNPROCESSABLE') {
          await this.finish(v.id, { outcome: 'REJECT', code: 'ID_UNREADABLE', reasons: [] }, f, s);
          throw new Stopped();
        }
        throw err;
      }
    };

    // Final review I1: the read is recorded as done but what it found was lost. Read once more, or a person decides.
    const lostRead = v.readOutcome === 'SUCCEEDED' && !f.id;
    if (lostRead && v.readSends >= 2) return system();
    if (v.readOutcome !== 'SUCCEEDED' || lostRead) {
      const r = await readId(lostRead);
      portrait = r.portrait;
      readThisRun = true;
      if (lostRead) f.readAgain = true;
      await this.recordIdRead(v.id, idType, r.read, f);
    }
    const base = { idType, read: f.id!, verified, t, today };

    let d = decideIdentity(base);
    if (d.outcome === 'REJECT') return this.finish(v.id, d, f, s);

    if (v.livenessOutcome === 'SUCCEEDED' && !f.liveness) return system();
    if (v.livenessOutcome !== 'SUCCEEDED') {
      f.liveness = (await this.paid(v.id, 'liveness', () => this.dojah.liveness(selfie), false)).read;
      await this.saveFindings(v.id, f);
    }
    d = decideIdentity({ ...base, liveness: f.liveness });
    if (d.outcome === 'REJECT') return this.finish(v.id, d, f, s);

    if (v.matchOutcome === 'SUCCEEDED' && !f.match && !f.noPortrait) return system();
    if (v.matchOutcome !== 'SUCCEEDED' && !f.noPortrait) {
      if (!portrait && !readThisRun) {
        // The portrait is never stored (spec §6): read the ID again, but at most ONCE per attempt
        // (final review C1), and never while the face match is in flight on another worker.
        const now = await this.prisma.advancedVerification.findUniqueOrThrow({ where: { id: v.id }, select: { matchOutcome: true, matchStartedAt: true, readSends: true } });
        const matchBusy = now.matchOutcome === 'IN_FLIGHT' && !!now.matchStartedAt && now.matchStartedAt.getTime() >= Date.now() - LEASE_MS;
        if (matchBusy) throw new BusyError(v.id);
        if (now.readSends >= 2) return system();
        portrait = (await readId(true)).portrait;
        f.readAgain = true;
      }
      if (!portrait) f.noPortrait = true;
      else f.match = (await this.paid(v.id, 'match', () => this.dojah.faceMatch(selfie, portrait!), false)).read;
      await this.saveFindings(v.id, f);
    }

    const duplicate = await this.isDuplicate(v.id, v.userId);
    d = decideIdentity({ ...base, liveness: f.liveness, match: f.match, noPortrait: f.noPortrait, duplicate });
    return this.finish(v.id, d, f, s);
  }

  /** Keeps the minimum (spec §5.2): never the full number, never the portrait. */
  private async recordIdRead(id: string, idType: string, read: IdRead, f: Findings): Promise<void> {
    const number = read.documentNumber?.replace(/\s+/g, '').toUpperCase() || null;
    f.id = { ...read, documentNumber: null };
    await this.prisma.advancedVerification.updateMany({
      where: { id, state: 'CHECKING' },
      data: {
        findings: f as Prisma.InputJsonValue,
        docHash: number ? this.hasher.hash(`${idType}:${number}`) : null,
        docLast4: number ? number.slice(-4) : null,
        docDateOfBirth: read.dateOfBirth,
      },
    });
  }

  private async isDuplicate(id: string, userId: string): Promise<boolean> {
    const me = await this.prisma.advancedVerification.findUniqueOrThrow({ where: { id }, select: { docHash: true, docDateOfBirth: true } });
    if (!me.docHash) return false;
    const other = await this.prisma.advancedVerification.findFirst({
      where: { id: { not: id }, userId: { not: userId }, step: 'IDENTITY', state: 'APPROVED', docHash: me.docHash, docDateOfBirth: me.docDateOfBirth },
      select: { id: true },
    });
    return !!other;
  }

  protected async base64(documentId: string): Promise<string> {
    const doc = await this.prisma.kycDocument.findUniqueOrThrow({ where: { id: documentId }, select: { storageKey: true } });
    const obj = await this.files.get(doc.storageKey); // StorageUnavailableError → the job retries
    if (!obj) throw new Error(`Advanced: the stored file for document ${documentId} is missing`);
    return obj.bytes.toString('base64');
  }

  protected async saveFindings(id: string, f: Findings): Promise<void> {
    await this.prisma.advancedVerification.updateMany({ where: { id, state: 'CHECKING' }, data: { findings: f as Prisma.InputJsonValue } });
  }

  /**
   * Claim → send → record. `again` allows a claim from SUCCEEDED, for the one
   * re-read the portrait rule needs.
   */
  protected async paid<T extends { httpStatus: number }>(id: string, call: Call, fn: () => Promise<T>, again: boolean): Promise<T> {
    const c = COL(call);
    const v = (await this.prisma.advancedVerification.findUniqueOrThrow({ where: { id } })) as unknown as Record<string, unknown>;
    const outcome = (v[c.outcome] as DojahCallOutcome | null) ?? null;
    const started = v[c.started] as Date | null;
    const sends = v[c.sends] as number;
    const stale = outcome === 'IN_FLIGHT' && !!started && started.getTime() < Date.now() - LEASE_MS;
    if (outcome === 'IN_FLIGHT' && !stale) throw new BusyError(id);
    if (outcome === 'SUCCEEDED' && !again) throw new Error(`Advanced ${id}: ${call} already succeeded`);
    const wasUnknown = outcome === 'UNKNOWN' || stale;
    if (wasUnknown && sends >= 2) {
      await this.failSystem(id, 'UNKNOWN_TWICE', true);
      throw new Stopped();
    }

    const claimed = await this.prisma.advancedVerification.updateMany({
      where: { id, state: 'CHECKING', [c.outcome]: outcome, [c.sends]: sends } as Prisma.AdvancedVerificationWhereInput,
      data: { [c.outcome]: 'IN_FLIGHT', [c.started]: new Date(), [c.sends]: { increment: 1 }, ...(wasUnknown ? { possiblyCharged: true } : {}) } as Prisma.AdvancedVerificationUpdateManyMutationInput,
    });
    if (claimed.count !== 1) throw new BusyError(id);

    try {
      const r = await fn();
      await this.prisma.advancedVerification.update({ where: { id }, data: { [c.outcome]: 'SUCCEEDED', [c.http]: r.httpStatus } as Prisma.AdvancedVerificationUpdateInput });
      return r;
    } catch (err) {
      const e = err instanceof DojahError ? err : new DojahError('UNKNOWN', (err as Error).message, 0);
      await this.prisma.advancedVerification.update({
        where: { id },
        data: { [c.outcome]: e.definitelyFailed ? 'DEFINITELY_FAILED' : 'UNKNOWN', [c.http]: e.httpStatus || null } as Prisma.AdvancedVerificationUpdateInput,
      });
      if (e.kind === 'BAD_REQUEST') {
        // Dojah refused this request (e.g. one customer's image): retrying would only pay again.
        // A person looks at the files; ops are told in case it's every request (final review I6).
        await this.alerts.raise(AlertType.DOJAH_CONFIG, 'dojah:BAD_REQUEST', 'Dojah refused an Advanced check request', [e.message]);
        await this.prisma.advancedVerification.updateMany({
          where: { id, state: 'CHECKING' },
          data: { state: 'IN_REVIEW', reviewReasons: ['SYSTEM'], customerMessage: MSG_IN_REVIEW, failureReason: 'BAD_REQUEST' },
        });
        throw new Stopped();
      }
      if (STOP_KINDS.has(e.kind)) {
        if (e.kind === 'WALLET') this.readiness?.markNotReady('wallet');
        if (e.kind === 'AUTH' || e.kind === 'IP') this.readiness?.markNotReady('keys');
        await this.alerts.raise(AlertType.DOJAH_CONFIG, `dojah:${e.kind}`, 'Dojah call failed: Advanced verification affected', [e.message]);
        await this.failSystem(id, e.kind, false);
        throw new Stopped();
      }
      throw e; // NOT_SENT / RATE_LIMITED / SERVER (free) and UNKNOWN (one re-send) → BullMQ retries
    }
  }

  /**
   * Spec §6: queue again any CHECKING row nobody has touched for 6 minutes (a
   * lost job, a Redis restart): longer than BullMQ's longest retry delay (320 s),
   * so a job that is only waiting is not doubled. End any still CHECKING after an
   * hour. Ending is FAILED_SYSTEM, which never counts against the customer.
   */
  async sweep(now = new Date()): Promise<{ requeued: number; timedOut: number }> {
    const quiet = new Date(now.getTime() - 6 * 60_000);
    const old = new Date(now.getTime() - 60 * 60_000);
    let timedOut = 0;
    for (const v of await this.prisma.advancedVerification.findMany({ where: { state: 'CHECKING', createdAt: { lt: old } }, take: 100 })) {
      const unsure = [v.readOutcome, v.livenessOutcome, v.matchOutcome, v.addressOutcome].some((o) => o === 'IN_FLIGHT' || o === 'UNKNOWN');
      await this.failSystem(v.id, 'TIMED_OUT', unsure);
      timedOut++;
    }
    let requeued = 0;
    // A fresh job id every 10 minutes: BullMQ ignores an id it already holds, even a finished one.
    const bucket = `r${Math.floor(now.getTime() / 600_000)}`;
    const quietRows = await this.prisma.advancedVerification.findMany({
      where: { state: 'CHECKING', updatedAt: { lt: quiet }, createdAt: { gte: old } },
      take: 100,
      select: { id: true },
    });
    for (const v of quietRows) {
      await this.submitter.enqueue(v.id, bucket).catch((e) => this.log.warn(`requeue ${v.id}: ${(e as Error).message}`));
      requeued++;
    }
    return { requeued, timedOut };
  }

  /** Our side or Dojah's failed: frees the slot and never counts against the customer. */
  async failSystem(id: string, reason: string, possiblyCharged: boolean): Promise<void> {
    await this.prisma.advancedVerification.updateMany({
      where: { id, state: 'CHECKING' },
      data: { state: 'FAILED_SYSTEM', activeFor: null, failureReason: reason, customerMessage: MSG_FAILED_SYSTEM, ...(possiblyCharged ? { possiblyCharged: true } : {}) },
    });
  }

  /** The decision, with a compare-and-set from CHECKING; approval raises the level in the same transaction. */
  protected async finish(id: string, d: Decision, f: Findings, s: DojahSettings): Promise<void> {
    // A review with no reason would leave the admin guessing: name it.
    const reasons = d.outcome === 'REVIEW' && d.reasons.length === 0 ? ['SYSTEM' as const] : d.reasons;
    const effects = await this.prisma.$transaction(async (tx) => {
      // Someone (a person, a sweep, another worker) moved it on: leave their result alone.
      const still = await tx.advancedVerification.updateMany({ where: { id, state: 'CHECKING' }, data: { findings: f as Prisma.InputJsonValue, reviewReasons: reasons } });
      if (still.count !== 1) return [];
      if (d.outcome === 'APPROVE') return this.approver.approve(tx, id, 'CHECKING');
      if (d.outcome === 'REJECT') {
        const message = d.code === 'DOC_TOO_OLD' ? tooOldMessage(s.addressRecencyMonths) : REJECT_MESSAGES[d.code as keyof typeof REJECT_MESSAGES];
        return this.approver.reject(tx, id, d.code, message, 'CHECKING');
      }
      await tx.advancedVerification.updateMany({ where: { id, state: 'CHECKING' }, data: { state: 'IN_REVIEW', customerMessage: MSG_IN_REVIEW } });
      return [];
    });
    await runEffects(effects, this.log);
  }

  /** Step B (spec §4.2, §7.2, §9): one proof-of-address document of the customer's choice. */
  protected async runAddress(v: AdvancedVerification, s: DojahSettings): Promise<void> {
    const verified = await this.verified(v.userId);
    const today = lagosDate(new Date());
    const kind = v.addressKind!;
    const doc = await this.prisma.kycDocument.findUniqueOrThrow({ where: { id: v.addressDocumentId! }, select: { id: true, storageKey: true, mimeType: true } });
    const f: Findings = { ...(v.findings as Findings) };
    const pdf = doc.mimeType === 'application/pdf';
    const decide = () => decideAddress({ kind, pdf, evidence: f.address, recencyMonths: s.addressRecencyMonths, today });

    // A PDF: the readers take pictures only, so a person reads it.
    if (pdf) return this.finish(v.id, decide(), f, s);

    if (v.addressOutcome === 'SUCCEEDED' && !f.address) {
      // A crash lost what a paid call found: a person decides rather than paying again.
      return this.finish(v.id, { outcome: 'REVIEW', reasons: ['SYSTEM'] }, f, s);
    }

    if (v.addressOutcome !== 'SUCCEEDED') {
      try {
        if (kind === 'UTILITY_BILL') {
          // Dojah's bill reader takes a link only: one file, 300 seconds, recorded, never stored.
          const link = await this.files.temporaryLink(doc.storageKey, 300);
          await this.prisma.adminAuditLog.create({
            data: {
              adminUserId: SYSTEM_ACTOR_ID,
              action: 'kyc.document.shared_with_provider',
              entity: 'KycDocument',
              entityId: doc.id,
              after: { provider: 'dojah', purpose: 'utility_bill', expiresInSeconds: 300 },
            },
          });
          f.linkShared = true;
          const r = await this.paid(v.id, 'address', () => this.dojah.utilityBill(link), false);
          f.address = summariseBill(r.read, verified);
        } else {
          const image = await this.base64(doc.id);
          const r = await this.paid(v.id, 'address', () => this.dojah.ocr(image), false);
          f.address = summariseText(r.lines, kind, verified, today); // the text itself is dropped here
        }
      } catch (err) {
        if (err instanceof DojahError && err.kind === 'UNPROCESSABLE') {
          return this.finish(v.id, { outcome: 'REJECT', code: 'DOC_UNREADABLE', reasons: [] }, f, s);
        }
        throw err;
      }
      await this.saveFindings(v.id, f);
    }
    return this.finish(v.id, decide(), f, s);
  }
}
