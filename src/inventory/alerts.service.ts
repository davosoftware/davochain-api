import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { AlertType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService, type InventoryRow } from './inventory.service';
import { MailService } from '../common/mail.service';
import { dec } from '../common/money';

const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * Admin alerts.
 *
 * On a normal day this sends exactly one email. Three rules keep it that way:
 *
 *  1. The digest is the default destination — if it is not time-critical it
 *     waits until morning. Under a manual-refill model almost nothing is, which
 *     is why the inventory cooldown is a WEEK rather than an hour.
 *  2. Only two things interrupt you: naira running out, and the books
 *     disagreeing. Everything else is a margin question, and margin keeps.
 *  3. Escalate on WORSENING, not on persisting. A coin still low tomorrow is
 *     not news; a coin that went from low to empty is.
 */
@Injectable()
export class AlertsService {
  private readonly log = new Logger(AlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  private async recipients(type: AlertType): Promise<string[]> {
    const rows = await this.prisma.alertRecipient.findMany({ where: { type, enabled: true } });
    if (rows.length > 0) return rows.map((r) => r.email);
    return this.config.get<string[]>('ALERT_DEFAULT_RECIPIENTS') ?? [];
  }

  async send(type: AlertType, subject: string, rows: InventoryRow[], lead: string): Promise<void> {
    const to = await this.recipients(type);
    if (to.length === 0) {
      this.log.warn(`No recipients configured for ${type} — alert not sent`);
      return;
    }

    const html = this.renderHtml(subject, lead, rows);
    const text = this.renderText(subject, lead, rows);

    for (const address of to) {
      // MailService logs every attempt and never throws — a silently failed
      // alert is the same as no alert, so it has to be recorded either way.
      await this.mail.send({ to: address, subject, text, html });
    }
  }

  // ── scheduled checks ────────────────────────────────────────

  /**
   * The daily digest doubles as the health check.
   *
   * If SMTP credentials expire or the worker dies you would simply stop getting
   * alerts — and "no alerts" looks exactly like "nothing is wrong". A fixed
   * morning send turns silence from ambiguous into meaningful.
   */
  @Cron('0 7 * * *', { name: 'daily-digest' })
  async dailyDigest(): Promise<void> {
    const rows = await this.inventory.snapshot();
    const fuel = await this.inventory.fuelLevel();
    await this.send(
      AlertType.DAILY_DIGEST,
      `Davochain daily — ₦${fuel.balanceNgn.toFixed(0)} fuel, ${fuel.daysOfCover.toFixed(1)} days cover`,
      rows,
      `Naira fuel: ₦${fuel.balanceNgn.toFixed(0)} (${fuel.daysOfCover.toFixed(1)} days of cover at the current run rate).`,
    );
    await this.inventory.recordAlert(AlertType.DAILY_DIGEST, null, {
      fuel: fuel.balanceNgn.toFixed(),
    });
  }

  /** Dips are the actionable signal — a rise while you are low means nothing. */
  @Cron('*/15 * * * *', { name: 'dip-watch' })
  async dipWatch(): Promise<void> {
    const rows = await this.inventory.snapshot();
    const settings = await this.prisma.inventorySetting.findMany();
    const thresholds = new Map(settings.map((s) => [s.assetCode, dec(s.dipAlertPct)]));

    const dips = rows.filter((r) => {
      const threshold = thresholds.get(r.asset) ?? dec(5);
      // Below what you sold at, and you actually have something to replace.
      return dec(r.vsAvgPct).lte(threshold.neg()) && Number(r.soldSinceRefill) > 0;
    });
    if (dips.length === 0) return;

    // Only the ones outside their cooldown. Collect first, send once — five
    // coins tripping in the same sweep is one email, not five.
    const fresh: typeof dips = [];
    for (const dip of dips) {
      if (await this.inventory.recentlyAlerted(AlertType.PRICE_DIP, dip.asset, DAY)) continue;
      await this.inventory.recordAlert(AlertType.PRICE_DIP, dip.asset, dip);
      fresh.push(dip);
    }

    if (fresh.length > 0) {
      await this.send(
        AlertType.PRICE_DIP,
        `Good time to restock: ${fresh.map((d) => d.asset.toUpperCase()).join(', ')}`,
        fresh,
        'These coins are trading below your average received price — restocking now is cheaper than what you sold at.',
      );
    }
  }

  /** Naira fuel. The only inventory-side thing allowed to wake someone up. */
  @Cron('0 * * * *', { name: 'fuel-watch' })
  async fuelWatch(): Promise<void> {
    const fuel = await this.inventory.fuelLevel();
    const rows = await this.inventory.snapshot();

    // Critical: buys are failing or about to. No cooldown beyond hourly.
    if (fuel.daysOfCover.lt(1)) {
      await this.send(
        AlertType.NGN_FUEL_CRITICAL,
        `CRITICAL: naira fuel at ₦${fuel.balanceNgn.toFixed(0)} — buys will start failing`,
        rows,
        `Less than a day of cover. Once this empties the fallback cannot execute and buys fail outright. Fund the Quidax NGN wallet now.`,
      );
      await this.inventory.recordAlert(AlertType.NGN_FUEL_CRITICAL, null, {
        balance: fuel.balanceNgn.toFixed(),
      });
      return;
    }

    if (fuel.daysOfCover.lt(3)) {
      if (await this.inventory.recentlyAlerted(AlertType.NGN_FUEL_LOW, null, 12 * HOUR)) return;
      await this.send(
        AlertType.NGN_FUEL_LOW,
        `Naira fuel low — ${fuel.daysOfCover.toFixed(1)} days of cover`,
        rows,
        'Top up the Quidax NGN wallet. This is what the fallback swap runs on when a coin runs out.',
      );
      await this.inventory.recordAlert(AlertType.NGN_FUEL_LOW, null, {
        balance: fuel.balanceNgn.toFixed(),
      });
    }
  }

  /** Inventory notices go in the digest, with a WEEK-long cooldown. */
  @Cron('0 6 * * *', { name: 'inventory-watch' })
  async inventoryWatch(): Promise<void> {
    const rows = await this.inventory.snapshot();
    const low = rows.filter((r) => r.belowFloor);

    for (const row of low) {
      if (await this.inventory.recentlyAlerted(AlertType.REFILL_NEEDED, row.asset, 7 * DAY))
        continue;
      await this.inventory.recordAlert(AlertType.REFILL_NEEDED, row.asset, row);
      await this.send(
        AlertType.REFILL_NEEDED,
        `${row.asset.toUpperCase()} inventory below floor`,
        [row],
        `Trading continues on the fallback — this costs about ₦${row.marginLostPerDayNgn} a day in margin until you restock.`,
      );
    }
  }

  // ── rendering ───────────────────────────────────────────────

  private renderHtml(subject: string, lead: string, rows: InventoryRow[]): string {
    const cells = rows
      .map(
        (r) => `<tr>
        <td>${r.asset.toUpperCase()}</td>
        <td align="right">${r.held}</td>
        <td align="right">${r.target}</td>
        <td align="right">${r.soldSinceRefill}</td>
        <td align="right">$${r.avgReceivedUsd}</td>
        <td align="right">$${r.priceNowUsd}</td>
        <td align="right" style="color:${Number(r.vsAvgPct) > 0 ? '#a33' : '#2a7'}">${r.vsAvgPct}%</td>
        <td align="right">$${r.restockCostUsd}</td>
        <td align="right">&#8358;${r.marginLostPerDayNgn}</td>
      </tr>`,
      )
      .join('');

    return `<div style="font-family:system-ui,sans-serif;font-size:14px">
      <h2 style="margin:0 0 8px">${subject}</h2>
      <p style="color:#555">${lead}</p>
      <table cellpadding="6" style="border-collapse:collapse;font-size:13px" border="1">
        <thead style="background:#f4f4f4">
          <tr>
            <th>Coin</th><th>Held</th><th>Target</th><th>Sold since refill</th>
            <th>Avg received</th><th>Price now</th><th>vs avg</th>
            <th>Restock cost</th><th>Margin lost/day</th>
          </tr>
        </thead>
        <tbody>${cells}</tbody>
      </table>
      <p style="color:#888;font-size:12px">
        Sort by <em>margin lost per day</em>; buy the ones where <em>vs avg</em> is negative.
      </p>
    </div>`;
  }

  private renderText(subject: string, lead: string, rows: InventoryRow[]): string {
    const lines = rows.map(
      (r) =>
        `${r.asset.toUpperCase().padEnd(6)} held ${r.held.padStart(14)}  vs avg ${r.vsAvgPct.padStart(7)}%  restock $${r.restockCostUsd.padStart(10)}  lost/day NGN ${r.marginLostPerDayNgn}`,
    );
    return [subject, '', lead, '', ...lines].join('\n');
  }
}
