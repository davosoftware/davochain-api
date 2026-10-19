import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, OnModuleInit, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AdminRole, AlertType, Prisma, TreasuryMoveStatus, TxStatus, TxType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SettlementService } from '../trades/settlement.service';
import { OpsAlertsService } from '../common/ops-alerts/ops-alerts.service';
import { JobLeaseService } from '../common/job-lease.service';
import { Decimal, ZERO, dec } from '../common/money';
import { NAIRA_RAIL, type NairaRail, RailRefusedError, RailUnknownError } from '../naira-rail/naira-rail';
import { RailTransferHooks } from '../naira-rail/rail-transfer-hooks';
import { PasswordService } from '../auth/password.service';
import { WRONG_PASSWORD_MESSAGE } from '../admin/ngn-withdrawals.service';

const OPEN: TreasuryMoveStatus[] = [TreasuryMoveStatus.SENDING, TreasuryMoveStatus.CHECKING];
export const TREASURY_REF_PREFIX = 'trsy_';
type Actor = { id: string; role: AdminRole };

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
export class TreasuryService implements OnModuleInit {
  protected readonly log = new Logger(TreasuryService.name);

  constructor(
    protected readonly prisma: PrismaService,
    @Inject(NAIRA_RAIL) protected readonly rail: NairaRail,
    protected readonly settlement: SettlementService,
    protected readonly alerts: OpsAlertsService,
    @Optional() protected readonly leases?: JobLeaseService,
    @Optional() protected readonly passwords?: PasswordService,
    @Optional() protected readonly hooks?: RailTransferHooks,
  ) {}

  onModuleInit(): void {
    // The rail's webhook for one of our moves: ask the rail what happened.
    this.hooks?.on(TREASURY_REF_PREFIX, (reference) => this.recheck(reference));
  }

  private assertOwner(actor: Actor): void {
    if (actor.role !== AdminRole.OWNER) throw new ForbiddenException('Only an owner can do this');
  }

  private async assertPassword(adminId: string, password: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId }, select: { passwordHash: true } });
    if (!admin || !this.passwords || !(await this.passwords.verify(password, admin.passwordHash))) {
      throw new BadRequestException(WRONG_PASSWORD_MESSAGE);
    }
  }

  /**
   * Owners only, with their password: the payout reserve, and the bank account
   * Quidax gives us for funding our main account (checked with the bank).
   * Returns before and after, for the audit log.
   */
  async saveSettings(
    actor: Actor,
    input: { payoutReserveNgn?: number; fundingBankCode?: string; fundingAccountNumber?: string; password: string },
  ) {
    this.assertOwner(actor);
    await this.assertPassword(actor.id, input.password);
    const data: Record<string, unknown> = { updatedBy: actor.id };
    if (input.payoutReserveNgn !== undefined) {
      if (!Number.isInteger(input.payoutReserveNgn) || input.payoutReserveNgn < 0) throw new BadRequestException('Enter a whole naira amount, 0 or more.');
      data.payoutReserveNgn = String(input.payoutReserveNgn);
    }
    if (input.fundingBankCode !== undefined || input.fundingAccountNumber !== undefined) {
      const code = input.fundingBankCode ?? '';
      const number = input.fundingAccountNumber ?? '';
      if (!/^\d{10}$/.test(number)) throw new BadRequestException('Enter a valid 10-digit Nigerian bank account number');
      const bank = (await this.rail.banks()).find((b) => b.code === code);
      if (!bank) throw new BadRequestException('Choose a supported Nigerian bank');
      const { accountName } = await this.rail.resolveAccount({ bankCode: code, accountNumber: number });
      Object.assign(data, { quidaxFundingBankCode: code, quidaxFundingBankName: bank.name, quidaxFundingAccountNumber: number, quidaxFundingAccountName: accountName });
    }
    const before = await this.prisma.treasurySettings.findUnique({ where: { id: 'default' } });
    await this.prisma.treasurySettings.upsert({ where: { id: 'default' }, create: { id: 'default', ...data }, update: data });
    const after = await this.prisma.treasurySettings.findUnique({ where: { id: 'default' } });
    return { before, after };
  }

  /** Banks the rail can pay, for the funding-account picker. */
  banks() {
    return this.rail.banks();
  }

  /** The bank's name for an account, for the screen's "Check name" (no saving). */
  async checkName(input: { bankCode: string; accountNumber: string }) {
    const bank = (await this.rail.banks()).find((b) => b.code === input.bankCode);
    if (!bank) throw new BadRequestException('Choose a supported Nigerian bank');
    return { bankName: bank.name, ...(await this.rail.resolveAccount(input)) };
  }

  /**
   * An owner sends company naira from the rail to Quidax (decision 19 Oct: no
   * second approval). Never more than is available to move; one move open at a
   * time (also enforced by the database). Written first, then sent once.
   */
  async sendToQuidax(actor: Actor, input: { amount: number | string; password: string }) {
    this.assertOwner(actor);
    await this.assertPassword(actor.id, input.password);
    const amount = Number(input.amount);
    if (!Number.isInteger(amount) || amount <= 0) throw new BadRequestException('Enter a whole naira amount above zero.');

    const settings = await this.prisma.treasurySettings.findUnique({ where: { id: 'default' } });
    if (!settings?.quidaxFundingBankCode || !settings.quidaxFundingAccountNumber) {
      throw new BadRequestException('Set the Quidax funding account first.');
    }
    const open = await this.prisma.treasuryMove.findFirst({ where: { status: { in: OPEN } }, select: { id: true } });
    if (open) throw new ConflictException('A move is still being sent. Wait for it to arrive or fail.');

    const s = await this.snapshot();
    if (s.availableToMove === null) throw new ServiceUnavailableException(`We couldn't read the ${this.rail.name} balance. Try again shortly.`);
    if (dec(amount).gt(dec(s.availableToMove))) {
      throw new BadRequestException(`You can move up to ${naira(dec(s.availableToMove))} now (the rest is the payout reserve or withdrawals still being sent).`);
    }

    const reference = `${TREASURY_REF_PREFIX}${randomUUID()}`;
    let move: { id: string };
    try {
      move = await this.prisma.treasuryMove.create({
        data: {
          reference,
          amount: String(amount),
          toBankCode: settings.quidaxFundingBankCode,
          toBankName: settings.quidaxFundingBankName ?? '',
          toAccountNumber: settings.quidaxFundingAccountNumber,
          toAccountName: settings.quidaxFundingAccountName ?? '',
          createdBy: actor.id,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('A move is still being sent. Wait for it to arrive or fail.');
      }
      throw err;
    }

    try {
      const t = await this.rail.transfer({
        reference,
        bankCode: settings.quidaxFundingBankCode,
        accountNumber: settings.quidaxFundingAccountNumber,
        amount: dec(amount),
        narration: 'DavoChain treasury to Quidax',
      });
      const arrived = t.status === 'SUCCESSFUL';
      await this.prisma.treasuryMove.updateMany({
        where: { id: move.id, status: { in: OPEN } },
        data: {
          railRef: t.id,
          railFee: t.fee?.toFixed() ?? null,
          ...(arrived ? { status: TreasuryMoveStatus.ARRIVED, completedAt: new Date() } : {}),
          ...(t.status === 'FAILED' ? { status: TreasuryMoveStatus.FAILED, failureReason: t.reason, completedAt: new Date() } : {}),
        },
      });
      return { moveId: move.id, reference, status: arrived ? 'ARRIVED' : t.status === 'FAILED' ? 'FAILED' : 'SENDING', reason: t.reason };
    } catch (err) {
      if (err instanceof RailRefusedError) {
        await this.prisma.treasuryMove.updateMany({
          where: { id: move.id, status: { in: OPEN } },
          data: { status: TreasuryMoveStatus.FAILED, failureReason: err.message.slice(0, 500), completedAt: new Date() },
        });
        return { moveId: move.id, reference, status: 'FAILED', reason: err.message };
      }
      // Unclear (or anything else): it may have gone. Never assume; ask by reference later.
      await this.prisma.treasuryMove.updateMany({ where: { id: move.id, status: { in: OPEN } }, data: { status: TreasuryMoveStatus.CHECKING } });
      if (!(err instanceof RailUnknownError)) this.log.error(`Treasury move ${reference}: ${(err as Error).message}`);
      return { moveId: move.id, reference, status: 'CHECKING', reason: null };
    }
  }

  /** Ask the rail about one of our moves; finish it once. A reference that isn't an open move of ours does nothing. */
  async recheck(reference: string): Promise<void> {
    const move = await this.prisma.treasuryMove.findFirst({ where: { reference } });
    if (!move || !OPEN.includes(move.status as TreasuryMoveStatus)) return;
    const t = await this.rail.transferStatus(reference);
    if (!t || t.status === 'PENDING') return;
    await this.prisma.treasuryMove.updateMany({
      where: { reference, status: { in: OPEN } },
      data:
        t.status === 'SUCCESSFUL'
          ? { status: TreasuryMoveStatus.ARRIVED, railRef: t.id, railFee: t.fee?.toFixed() ?? null, completedAt: new Date() }
          : { status: TreasuryMoveStatus.FAILED, railRef: t.id, failureReason: (t.reason ?? 'The transfer failed').slice(0, 500), completedAt: new Date() },
    });
  }

  /** Backup for a lost webhook: every 10 minutes, ask about moves open for over 2 minutes. */
  @Cron('*/10 * * * *', { name: 'treasury-recheck' })
  async recheckOpenCron(): Promise<void> {
    if (!this.leases) return this.recheckOpen();
    await this.leases.run('treasury-recheck', 8 * 60_000, () => this.recheckOpen());
  }

  async recheckOpen(): Promise<void> {
    const open = await this.prisma.treasuryMove.findMany({
      where: { status: { in: OPEN }, createdAt: { lt: new Date(Date.now() - 2 * 60_000) } },
      select: { reference: true },
    });
    for (const m of open) {
      await this.recheck(m.reference).catch((err: Error) => this.log.warn(`Could not re-check ${m.reference}: ${err.message}`));
    }
  }

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
