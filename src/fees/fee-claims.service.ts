import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ClaimRunStatus, SettlementLegKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QuidaxClient } from '../quidax/quidax.client';
import { SettlementService } from '../trades/settlement.service';
import { RatesService } from '../rates/rates.service';
import { Decimal, ZERO, dec, str } from '../common/money';
import { JOBS, QUEUES, jobId } from '../common/queues';

export interface ClaimableRow {
  asset: string;
  users: number;
  held: string;
  accruedUsd: string;
  currentUsd: string;
  driftPct: string;
  direct: number;
  convert: number;
  belowThreshold: number;
  estimatedCalls: number;
}

/**
 * Fee collection, triggered by an admin rather than a cron.
 *
 * The fee was disclosed on the swap screen and debited from the user's ledger
 * at trade time — their balance already reflects it. A claim moves money the
 * platform already owns from one wallet it controls to another. That is a
 * treasury operation, not a charge, which is why nothing appears in the user's
 * history and why THIS PATH MUST NEVER WRITE TO `balances`.
 */
@Injectable()
export class FeeClaimsService {
  private readonly log = new Logger(FeeClaimsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly quidax: QuidaxClient,
    private readonly settlement: SettlementService,
    private readonly rates: RatesService,
    private readonly config: ConfigService,
    @InjectQueue(QUEUES.FEE_CLAIMS) private readonly queue: Queue,
  ) {}

  private destination(): string {
    return (this.config.get<string>('FEE_CLAIM_DESTINATION') ?? 'usdt').toLowerCase();
  }

  /**
   * The claim screen: grouped by coin, never a list of thousands of fees.
   *
   * "Accrued" is what the fees were worth when charged — what the revenue report
   * expects. "Current" is what claiming today would actually realise. The gap is
   * drift, because the fee is denominated in USD but HELD in coin until claimed.
   */
  async claimable(): Promise<ClaimableRow[]> {
    const rows = await this.prisma.feeReceivable.findMany({
      where: { sweptAt: null, claimRunId: null },
      include: { asset: true },
    });

    const byAsset = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byAsset.get(r.assetCode) ?? [];
      list.push(r);
      byAsset.set(r.assetCode, list);
    }

    const out: ClaimableRow[] = [];
    for (const [assetCode, list] of byAsset) {
      const held = list.reduce((s, r) => s.plus(dec(r.amount)), ZERO);
      const accruedUsd = list.reduce((s, r) => s.plus(dec(r.usdAtAccrual)), ZERO);

      let priceUsd = ZERO;
      try {
        priceUsd = (await this.rates.price(assetCode)).priceUsd;
      } catch {
        // Pricing failure must not blank the whole screen.
      }
      const currentUsd = held.mul(priceUsd);
      const drift = accruedUsd.isZero()
        ? ZERO
        : currentUsd.minus(accruedUsd).div(accruedUsd).mul(100);

      const asset = list[0].asset;
      const transferMin = asset.transferMin ? dec(asset.transferMin) : ZERO;
      const minAmount = dec(this.config.get<number>('FEE_CLAIM_MIN_USD') ?? 1.5);

      let direct = 0;
      let convert = 0;
      let below = 0;
      for (const r of list) {
        const amount = dec(r.amount);
        const usd = amount.mul(priceUsd);
        if (assetCode === this.destination() && amount.gte(transferMin)) direct++;
        else if (usd.gte(minAmount)) convert++;
        else below++;
      }

      out.push({
        asset: assetCode,
        users: list.length,
        held: str(held, asset.displayScale),
        accruedUsd: accruedUsd.toFixed(2),
        currentUsd: currentUsd.toFixed(2),
        driftPct: drift.toFixed(1),
        direct,
        convert,
        belowThreshold: below,
        // A direct transfer is one call; a conversion is quote + confirm + transfer.
        estimatedCalls: direct * 1 + convert * 3,
      });
    }

    return out.sort((a, b) => Number(b.currentUsd) - Number(a.currentUsd));
  }

  /**
   * Enqueue rather than execute.
   *
   * Every receivable lives in a different sub-account and there is no bulk
   * sweep, so 400 fees is 400+ calls. Run on the background lane (~30/min) so
   * a claim takes half an hour in the background and never starves live trading.
   */
  async startRun(
    adminId: string,
    assetCodes: string[],
  ): Promise<{ runId: string; queued: number }> {
    const receivables = await this.prisma.feeReceivable.findMany({
      where: { sweptAt: null, claimRunId: null, assetCode: { in: assetCodes } },
      select: { id: true },
    });

    const run = await this.prisma.feeClaimRun.create({
      data: {
        triggeredBy: adminId,
        assetCodes,
        destination: this.destination(),
        status: ClaimRunStatus.QUEUED,
        totalCount: receivables.length,
      },
    });

    await this.prisma.feeReceivable.updateMany({
      where: { id: { in: receivables.map((r) => r.id) } },
      data: { claimRunId: run.id },
    });

    for (const r of receivables) {
      await this.queue.add(
        JOBS.CLAIM_FEE,
        { runId: run.id, receivableId: r.id },
        { jobId: jobId('claim', r.id) },
      );
    }

    await this.prisma.feeClaimRun.update({
      where: { id: run.id },
      data: { status: ClaimRunStatus.RUNNING, startedAt: new Date() },
    });

    this.log.log(`Claim run ${run.id}: ${receivables.length} receivable(s) queued by ${adminId}`);
    return { runId: run.id, queued: receivables.length };
  }

  /**
   * Collect one receivable. Per-user, so a failure is isolated — one user's
   * failed swap does not touch the other 399.
   *
   * The receivable is cleared only AFTER the transfer confirms, so a crash
   * mid-run leaves it claimable rather than lost or double-swept.
   */
  async claimOne(runId: string, receivableId: string): Promise<'direct' | 'converted' | 'skipped'> {
    const receivable = await this.prisma.feeReceivable.findUnique({
      where: { id: receivableId },
      include: { asset: true },
    });
    if (!receivable || receivable.sweptAt) return 'skipped';

    const destination = this.destination();
    const amount = dec(receivable.amount);
    const subId = await this.settlement.quidaxIdFor(receivable.userId);
    const mainId = await this.settlement.mainAccount();
    const transferMin = receivable.asset.transferMin ? dec(receivable.asset.transferMin) : ZERO;

    // Already at the destination and big enough to move: one call, no spread.
    if (receivable.assetCode === destination && amount.gte(transferMin)) {
      await this.transferToMain(runId, receivable.userId, subId, mainId, destination, amount);
      await this.markSwept(receivable.id, amount, destination);
      return 'direct';
    }

    // Otherwise convert inside the user's own sub-account, then move it.
    // Naira would also work as an escape hatch (its transfer minimum is ₦1),
    // but USDT is the configured destination and every coin has a USDT market.
    const quotation = await this.quidax.createSwapQuotation(
      subId,
      {
        from_currency: receivable.assetCode,
        to_currency: destination,
        from_amount: amount.toFixed(),
      },
      'background',
    );
    const swap = await this.quidax.confirmSwap(subId, quotation.id, 'background');
    const received = dec(swap.received_amount);

    await this.transferToMain(runId, receivable.userId, subId, mainId, destination, received);
    await this.markSwept(receivable.id, received, destination);
    return 'converted';
  }

  private async transferToMain(
    runId: string,
    userId: string,
    subId: string,
    mainId: string,
    currency: string,
    amount: Decimal,
  ): Promise<void> {
    const reference = this.quidax.newReference('feeclaim');
    await this.quidax.internalTransfer(
      subId,
      { currency, amount: amount.toFixed(), fund_uid: mainId, reference },
      'background',
    );
    this.log.log(`Claimed ${amount.toFixed()} ${currency} from ${userId} (run ${runId})`);
  }

  private async markSwept(
    receivableId: string,
    realised: Decimal,
    currency: string,
  ): Promise<void> {
    await this.prisma.feeReceivable.update({
      where: { id: receivableId },
      data: { sweptAt: new Date() },
    });
    const receivable = await this.prisma.feeReceivable.findUniqueOrThrow({
      where: { id: receivableId },
    });
    if (receivable.claimRunId) {
      await this.prisma.feeClaimRun.update({
        where: { id: receivable.claimRunId },
        data: {
          succeededCount: { increment: 1 },
          realisedUsd: { increment: currency === 'ngn' ? 0 : Number(realised.toFixed(8)) },
        },
      });
    }
  }

  async recordFailure(runId: string, receivableId: string, error: string): Promise<void> {
    await this.prisma.feeClaimRun.update({
      where: { id: runId },
      data: { failedCount: { increment: 1 } },
    });
    // Release it so the next run can retry — never leave it stranded.
    await this.prisma.feeReceivable.update({
      where: { id: receivableId },
      data: { claimRunId: null },
    });
    this.log.error(`Claim failed for receivable ${receivableId}: ${error}`);
  }

  async runStatus(runId: string) {
    const run = await this.prisma.feeClaimRun.findUniqueOrThrow({ where: { id: runId } });
    const done = run.succeededCount + run.failedCount;
    return {
      id: run.id,
      status: run.status,
      destination: run.destination,
      assets: run.assetCodes,
      total: run.totalCount,
      succeeded: run.succeededCount,
      failed: run.failedCount,
      progress: run.totalCount === 0 ? 1 : done / run.totalCount,
      realisedUsd: str(run.realisedUsd, 2),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    };
  }

  async finaliseIfDone(runId: string): Promise<void> {
    const run = await this.prisma.feeClaimRun.findUniqueOrThrow({ where: { id: runId } });
    if (run.succeededCount + run.failedCount < run.totalCount) return;
    await this.prisma.feeClaimRun.update({
      where: { id: runId },
      data: {
        status:
          run.failedCount > 0 ? ClaimRunStatus.COMPLETED_WITH_ERRORS : ClaimRunStatus.COMPLETED,
        finishedAt: new Date(),
      },
    });
  }
}
