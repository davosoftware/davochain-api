import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AlertType } from '@prisma/client';
import { JobLeaseService } from '../common/job-lease.service';
import { PrismaService } from '../prisma/prisma.service';
import { OpsAlertsService } from '../common/ops-alerts/ops-alerts.service';
import { BasicVerificationService } from '../kyc/basic-verification.service';
import { AmlService } from '../compliance/aml.service';
import { redactIds } from '../common/redact';
import { AdvancedRunner } from '../kyc/advanced/advanced-runner.service';

export interface UnknownCall {
  kind: 'LOOKUP' | 'AML' | 'ADVANCED';
  id: string;
  userId: string;
  at: string;
  outcome: string;
  possiblyCharged: boolean;
  possibleDuplicateCharge: boolean;
  entityId: string | null;
}

/**
 * Settles paid Dojah calls whose outcome a crash or timeout left open (plan
 * §R1.3, §R1.4), on one server at a time, and lists the calls that may be on
 * Dojah's bill without a recorded result.
 */
@Injectable()
export class DojahRecoveryService {
  private readonly log = new Logger(DojahRecoveryService.name);

  constructor(
    private readonly lease: JobLeaseService,
    private readonly basic: BasicVerificationService,
    private readonly aml: AmlService,
    private readonly prisma: PrismaService,
    private readonly alerts: OpsAlertsService,
    @Optional() private readonly advanced?: AdvancedRunner,
  ) {}

  @Cron('*/2 * * * *', { name: 'dojah-recovery' })
  async cron(): Promise<void> {
    await this.tick().catch((e) => this.log.error(`dojah-recovery: ${redactIds((e as Error).message)}`));
  }

  async tick(): Promise<{ lookupsFailed: number; screensUnknown: number; retried: number; advanced?: { requeued: number; timedOut: number } }> {
    const r = await this.lease.run('dojah-recovery', 110_000, async () => {
      const lookupsFailed = await this.basic.failStaleLookups();
      const screensUnknown = await this.aml.markStaleInFlight();
      let retried = 0;
      for (const id of await this.aml.dueRetries()) {
        try {
          await this.aml.send(id);
          retried++;
        } catch (e) {
          this.log.error(`AML retry ${id}: ${redactIds((e as Error).message)}`);
        }
      }
      // Advanced attempts (spec 2026-10-21 §6): put back lost jobs, end stuck ones.
      const advanced = this.advanced ? await this.advanced.sweep() : undefined;
      return { lookupsFailed, screensUnknown, retried, ...(advanced ? { advanced } : {}) };
    });
    return r.ran ? r.result : { lookupsFailed: 0, screensUnknown: 0, retried: 0 };
  }

  /** For comparing against Dojah's statement. No names, hashes or digits. */
  async unknownCalls(): Promise<UnknownCall[]> {
    const inDoubt = (o: unknown) => o === 'UNKNOWN' || o === 'IN_FLIGHT';
    const [lookups, screens, advanced] = await Promise.all([
      this.prisma.kycVerification.findMany({
        where: { OR: [{ lookupOutcome: 'UNKNOWN' }, { lookupOutcome: 'IN_FLIGHT' }] },
        orderBy: { lookupStartedAt: 'desc' },
        take: 500,
      }),
      this.prisma.amlScreening.findMany({
        where: { OR: [{ callOutcome: 'UNKNOWN' }, { callOutcome: 'IN_FLIGHT' }, { possibleDuplicateCharge: true }] },
        orderBy: { screenStartedAt: 'desc' },
        take: 500,
      }),
      this.prisma.advancedVerification.findMany({
        where: {
          OR: [
            { readOutcome: { in: ['UNKNOWN', 'IN_FLIGHT'] } },
            { livenessOutcome: { in: ['UNKNOWN', 'IN_FLIGHT'] } },
            { matchOutcome: { in: ['UNKNOWN', 'IN_FLIGHT'] } },
            { addressOutcome: { in: ['UNKNOWN', 'IN_FLIGHT'] } },
          ],
        },
        orderBy: { updatedAt: 'desc' },
        take: 500,
      }),
    ]);
    return [
      ...lookups.map((v) => ({
        kind: 'LOOKUP' as const,
        id: v.id,
        userId: v.userId,
        at: (v.lookupStartedAt ?? new Date(0)).toISOString(),
        outcome: String(v.lookupOutcome),
        possiblyCharged: v.possiblyCharged,
        possibleDuplicateCharge: false,
        entityId: null,
      })),
      ...screens.map((s) => ({
        kind: 'AML' as const,
        id: s.id,
        userId: s.userId,
        at: (s.screenStartedAt ?? new Date(0)).toISOString(),
        outcome: String(s.callOutcome),
        possiblyCharged: true,
        possibleDuplicateCharge: s.possibleDuplicateCharge,
        entityId: s.entityId,
      })),
      ...advanced.map((a) => {
        const calls = [
          ['read', a.readOutcome],
          ['liveness', a.livenessOutcome],
          ['match', a.matchOutcome],
          ['address', a.addressOutcome],
        ] as const;
        return {
          kind: 'ADVANCED' as const,
          id: a.id,
          userId: a.userId,
          at: a.updatedAt.toISOString(),
          outcome: calls
            .filter(([, o]) => inDoubt(o))
            .map(([c, o]) => `${c}:${o}`)
            .join(','),
          possiblyCharged: true,
          possibleDuplicateCharge: a.readSends > 1 || a.livenessSends > 1 || a.matchSends > 1 || a.addressSends > 1,
          entityId: null,
        };
      }),
    ];
  }

  @Cron('0 8 * * 1', { name: 'dojah-unknown-digest', timeZone: 'Africa/Lagos' })
  async weeklyDigest(): Promise<void> {
    const rows = await this.unknownCalls();
    if (rows.length === 0) return;
    await this.alerts.raise(
      AlertType.DOJAH_CONFIG,
      'dojah:unknown-digest',
      `${rows.length} Dojah call(s) to reconcile against billing`,
      [
        `Lookups possibly billed without a result: ${rows.filter((r) => r.kind === 'LOOKUP').length}`,
        `AML screens unknown or possibly billed twice: ${rows.filter((r) => r.kind === 'AML').length}`,
        `Advanced checks in doubt: ${rows.filter((r) => r.kind === 'ADVANCED').length}`,
        'Details: System → Dojah → Calls to reconcile',
      ],
      6 * 24 * 3_600_000,
    );
  }
}
