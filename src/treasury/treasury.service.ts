import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AlertType, TxStatus, TxType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettlementService } from '../trades/settlement.service';
import { OpsAlertsService } from '../common/ops-alerts/ops-alerts.service';
import { JobLeaseService } from '../common/job-lease.service';
import { Decimal, ZERO, dec } from '../common/money';
import { NAIRA_RAIL, type NairaRail } from '../naira-rail/naira-rail';

export interface TreasurySnapshot {
  checkedAt: string;
  rail: { name: string; available: string | null; error: string | null };
  /** Our naira at Quidax (main account), used to buy coins. */
  quidaxNgn: string | null;
  /** Σ every customer's naira (available + locked). */
  owed: string;
  /** UNKNOWN when a balance couldn't be read: never reported as short. */
  covered: 'YES' | 'SHORT' | 'UNKNOWN';
  spare: string | null;
  shortBy: string | null;
  reserve: string;
  /** Customer naira withdrawals still being sent. */
  inFlightPayouts: string;
  /** What an owner may send to Quidax now. null when the rail balance is unknown. */
  availableToMove: string | null;
  fundingAccount: { bankCode: string; bankName: string; accountNumberMasked: string; accountName: string } | null;
  moves: Array<{
    id: string;
    amount: string;
    status: string;
    to: string;
    railRef: string | null;
    failureReason: string | null;
    createdBy: string;
    createdAt: Date;
    completedAt: Date | null;
  }>;
}

const naira = (d: Decimal) => '₦' + Number(d.toFixed(2)).toLocaleString('en-NG', { maximumFractionDigits: 2 });
const mask = (n: string) => '*'.repeat(Math.max(n.length - 4, 0)) + n.slice(-4);

/**
 * Treasury (decision 16–19 Oct): our naira at the naira rail and at Quidax,
 * against what customers are owed, checked daily (H4). Owner moves to Quidax
 * live here too (sendToQuidax).
 */
@Injectable()
export class TreasuryService {
  protected readonly log = new Logger(TreasuryService.name);

  constructor(
    protected readonly prisma: PrismaService,
    @Inject(NAIRA_RAIL) protected readonly rail: NairaRail,
    protected readonly settlement: SettlementService,
    protected readonly alerts: OpsAlertsService,
    @Optional() protected readonly leases?: JobLeaseService,
  ) {}

  async snapshot(): Promise<TreasurySnapshot> {
    const [railBal, quidax, balances, settings, inFlight, moves] = await Promise.all([
      this.rail.balance().then(
        (b) => b.available,
        () => null,
      ),
      this.settlement.inventory('ngn').then(
        (v) => v,
        () => null,
      ),
      this.prisma.balance.findMany({ where: { assetCode: 'ngn' }, select: { available: true, locked: true } }),
      this.prisma.treasurySettings.findUnique({ where: { id: 'default' } }),
      this.prisma.transaction.aggregate({
        where: {
          type: TxType.WITHDRAWAL,
          fromAsset: 'ngn',
          status: { in: [TxStatus.PENDING, TxStatus.PROCESSING, TxStatus.RECONCILING] },
        },
        _sum: { toAmount: true },
      }),
      this.prisma.treasuryMove.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);

    const owed = balances.reduce((s, b) => s.plus(dec(b.available)).plus(dec(b.locked)), ZERO);
    const reserve = dec(settings?.payoutReserveNgn ?? 0);
    const sending = dec(inFlight._sum.toAmount ?? 0);
    const held = railBal !== null && quidax !== null ? railBal.plus(quidax) : null;
    const covered = held === null ? 'UNKNOWN' : held.gte(owed) ? 'YES' : 'SHORT';
    const available = railBal === null ? null : Decimal.max(railBal.minus(reserve).minus(sending), 0);

    return {
      checkedAt: new Date().toISOString(),
      rail: {
        name: this.rail.name,
        available: railBal?.toFixed() ?? null,
        error: railBal === null ? `We couldn't read the ${this.rail.name} balance.` : null,
      },
      quidaxNgn: quidax?.toFixed() ?? null,
      owed: owed.toFixed(),
      covered,
      spare: covered === 'YES' ? held!.minus(owed).toFixed() : null,
      shortBy: covered === 'SHORT' ? owed.minus(held!).toFixed() : null,
      reserve: reserve.toFixed(),
      inFlightPayouts: sending.toFixed(),
      availableToMove: available?.toFixed() ?? null,
      fundingAccount:
        settings?.quidaxFundingBankCode && settings.quidaxFundingAccountNumber
          ? {
              bankCode: settings.quidaxFundingBankCode,
              bankName: settings.quidaxFundingBankName ?? '',
              accountNumberMasked: mask(settings.quidaxFundingAccountNumber),
              accountName: settings.quidaxFundingAccountName ?? '',
            }
          : null,
      moves: moves.map((m) => ({
        id: m.id,
        amount: dec(m.amount).toFixed(),
        status: m.status,
        to: `${m.toBankName} ${mask(m.toAccountNumber)}`,
        railRef: m.railRef,
        failureReason: m.failureReason,
        createdBy: m.createdBy,
        createdAt: m.createdAt,
        completedAt: m.completedAt,
      })),
    };
  }

  /** H4: every morning, are customers' naira covered, and is the payout reserve there? */
  @Cron('0 7 * * *', { name: 'treasury-check', timeZone: 'Africa/Lagos' })
  async dailyCheckCron(): Promise<void> {
    if (!this.leases) return this.dailyCheck();
    await this.leases.run('treasury-check', 50 * 60_000, () => this.dailyCheck(), { keep: true });
  }

  async dailyCheck(): Promise<void> {
    const s = await this.snapshot();
    if (s.covered === 'UNKNOWN') {
      this.log.warn(`Treasury check could not tell: ${s.rail.error ?? "the Quidax naira balance couldn't be read"}`);
      return;
    }
    const lines = [
      `Customers are owed: ${naira(dec(s.owed))}`,
      `Naira at ${s.rail.name}: ${naira(dec(s.rail.available!))}`,
      `Naira at Quidax: ${naira(dec(s.quidaxNgn!))}`,
      `Payout reserve: ${naira(dec(s.reserve))}`,
    ];
    if (s.covered === 'SHORT') {
      await this.alerts.raise(AlertType.TREASURY_SHORT, 'treasury:short', `Naira short by ${naira(dec(s.shortBy!))}: customers are owed more than we hold`, lines);
    }
    if (dec(s.rail.available!).lt(dec(s.reserve))) {
      await this.alerts.raise(
        AlertType.TREASURY_RESERVE_LOW,
        'treasury:reserve-low',
        `Naira at ${s.rail.name} is below the payout reserve: top it up`,
        lines,
      );
    }
  }
}
