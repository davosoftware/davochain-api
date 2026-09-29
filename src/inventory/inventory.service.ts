import { Injectable, Logger } from '@nestjs/common';
import { AlertType, TxType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettlementService } from '../trades/settlement.service';
import { RatesService } from '../rates/rates.service';
import { Decimal, ZERO, dec, str } from '../common/money';

export interface InventoryRow {
  asset: string;
  held: string;
  target: string;
  soldSinceRefill: string;
  avgReceivedUsd: string;
  priceNowUsd: string;
  /** Positive means dearer to restock than you sold at. */
  vsAvgPct: string;
  restockCostUsd: string;
  /** What being low is costing per day, in naira, at the current run rate. */
  marginLostPerDayNgn: string;
  belowFloor: boolean;
  fallbackEnabled: boolean;
}

/**
 * The desk does not trade. It watches, calculates, and tells you what to do.
 *
 * Auto-rebalancing through instant swap would convert a price risk into a
 * guaranteed cost on every refill, so the platform never buys inventory itself —
 * you restock wherever the price is actually good, and record it here.
 *
 * Inventory is a MARGIN choice, not a service requirement: with the fallback on,
 * an empty coin still trades, just at the gate alone rather than the gate plus
 * the restock edge. Naira in the Quidax wallet is the thing that must never run
 * out, because that is what the fallback runs on.
 */
@Injectable()
export class InventoryService {
  private readonly log = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settlement: SettlementService,
    private readonly rates: RatesService,
  ) {}

  /** The table every alert carries, and what /admin/inventory renders. */
  async snapshot(): Promise<InventoryRow[]> {
    const settings = await this.prisma.inventorySetting.findMany({ include: { asset: true } });
    const rows: InventoryRow[] = [];

    for (const setting of settings) {
      if (!setting.asset.isListed || setting.asset.isFiat) continue;

      const [held, period, price] = await Promise.all([
        this.settlement.inventory(setting.assetCode).catch(() => ZERO),
        this.openPeriod(setting.assetCode),
        this.rates.price(setting.assetCode).catch(() => null),
      ]);

      const target = dec(setting.target);
      const sold = dec(period?.soldQty ?? 0);
      const avgUsd = dec(period?.weightedAvgUsd ?? 0);
      const priceNow = price?.priceUsd ?? ZERO;

      const vsAvg = avgUsd.isZero() ? ZERO : priceNow.minus(avgUsd).div(avgUsd).mul(100);
      const gap = target.minus(held);
      const restockCost = gap.gt(0) ? gap.mul(priceNow) : ZERO;

      rows.push({
        asset: setting.assetCode,
        held: str(held, setting.asset.displayScale),
        target: str(target, setting.asset.displayScale),
        soldSinceRefill: str(sold, setting.asset.displayScale),
        avgReceivedUsd: avgUsd.toFixed(2),
        priceNowUsd: priceNow.toFixed(2),
        vsAvgPct: vsAvg.toFixed(1),
        restockCostUsd: restockCost.toFixed(2),
        marginLostPerDayNgn: (await this.marginLostPerDay(setting.assetCode)).toFixed(0),
        belowFloor: target.gt(0) && held.lt(target.mul(dec(setting.floorPct)).div(100)),
        fallbackEnabled: setting.fallbackSwapEnabled,
      });
    }

    return rows.sort((a, b) => Number(b.marginLostPerDayNgn) - Number(a.marginLostPerDayNgn));
  }

  /**
   * What running on fallback costs per day for a coin: the extra margin an
   * inventory settlement would have earned, at the current buy run rate.
   *
   * This is a RATE, not a hole — it does not grow when the price rises, and it
   * stops the moment you refill.
   */
  private async marginLostPerDay(assetCode: string): Promise<Decimal> {
    const since = new Date(Date.now() - 7 * 86_400_000);
    const trades = await this.prisma.transaction.findMany({
      where: {
        type: TxType.BUY,
        toAsset: assetCode,
        status: 'COMPLETED',
        createdAt: { gte: since },
      },
      select: { fromAmount: true },
    });
    if (trades.length === 0) return ZERO;

    const weeklyNgn = trades.reduce((s, t) => s.plus(dec(t.fromAmount ?? 0)), ZERO);
    // The restock edge is roughly Quidax's own spread — call it 0.4% of volume.
    return weeklyNgn.div(7).mul('0.004');
  }

  private async openPeriod(assetCode: string) {
    return this.prisma.refillPeriod.findFirst({
      where: { assetCode, closedAt: null },
      orderBy: { openedAt: 'desc' },
    });
  }

  /** Track a sale against the open period, so "avg received" stays honest. */
  async recordSale(assetCode: string, quantity: Decimal, usdPrice: Decimal): Promise<void> {
    let period = await this.openPeriod(assetCode);
    if (!period) {
      period = await this.prisma.refillPeriod.create({ data: { assetCode } });
    }

    const prevQty = dec(period.soldQty);
    const prevAvg = dec(period.weightedAvgUsd);
    const nextQty = prevQty.plus(quantity);
    const nextAvg = nextQty.isZero()
      ? ZERO
      : prevQty.mul(prevAvg).plus(quantity.mul(usdPrice)).div(nextQty);

    await this.prisma.refillPeriod.update({
      where: { id: period.id },
      data: { soldQty: nextQty.toFixed(), weightedAvgUsd: nextAvg.toFixed() },
    });
  }

  /** Record a restock made elsewhere. Closes the period and opens a fresh one. */
  async recordRefill(input: {
    assetCode: string;
    quantity: Decimal;
    pricePaidUsd: Decimal;
    occurredAt: Date;
    recordedBy: string;
    note?: string;
  }): Promise<void> {
    await this.prisma.refill.create({
      data: {
        assetCode: input.assetCode,
        quantity: input.quantity.toFixed(),
        pricePaidUsd: input.pricePaidUsd.toFixed(),
        occurredAt: input.occurredAt,
        recordedBy: input.recordedBy,
        note: input.note ?? null,
      },
    });

    const period = await this.openPeriod(input.assetCode);
    if (period) {
      await this.prisma.refillPeriod.update({
        where: { id: period.id },
        data: { closedAt: new Date() },
      });
    }
    await this.prisma.refillPeriod.create({ data: { assetCode: input.assetCode } });

    this.log.log(
      `Refill recorded: ${input.quantity.toFixed()} ${input.assetCode} at $${input.pricePaidUsd.toFixed(2)}`,
    );
  }

  /** Naira in the Quidax wallet — the fallback runs on this. */
  async fuelLevel(): Promise<{ balanceNgn: Decimal; dailyBurnNgn: Decimal; daysOfCover: Decimal }> {
    const balance = await this.settlement.inventory('ngn').catch(() => ZERO);

    const since = new Date(Date.now() - 7 * 86_400_000);
    const fallbackBuys = await this.prisma.transaction.findMany({
      where: {
        type: TxType.BUY,
        status: 'COMPLETED',
        settledFrom: 'FALLBACK_SWAP',
        createdAt: { gte: since },
      },
      select: { fromAmount: true },
    });

    const weekly = fallbackBuys.reduce((s, t) => s.plus(dec(t.fromAmount ?? 0)), ZERO);
    const daily = weekly.div(7);
    return {
      balanceNgn: balance,
      dailyBurnNgn: daily,
      daysOfCover: daily.isZero() ? dec(999) : balance.div(daily),
    };
  }

  /** Suppress a repeat within the cooldown — an alert channel that cries wolf gets ignored. */
  async recentlyAlerted(
    type: AlertType,
    assetCode: string | null,
    cooldownMs: number,
  ): Promise<boolean> {
    const last = await this.prisma.alert.findFirst({
      where: { type, assetCode },
      orderBy: { sentAt: 'desc' },
    });
    return Boolean(last && Date.now() - last.sentAt.getTime() < cooldownMs);
  }

  async recordAlert(type: AlertType, assetCode: string | null, payload: unknown): Promise<void> {
    await this.prisma.alert.create({
      data: { type, assetCode, payload: payload as never },
    });
  }
}
