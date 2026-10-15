import { Inject, Injectable, Optional } from '@nestjs/common';
import { AlertType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AlertRecipientsService } from '../common/ops-alerts/alert-recipients.service';
import { OpsAlertsService } from '../common/ops-alerts/ops-alerts.service';
import { DojahApi } from './dojah.client';
import { DojahConfig } from './dojah.config';
import { DojahError } from './dojah.errors';
import type { Readiness } from '../kyc/basic-verification.service';

export type CheckKey = 'mode' | 'credentials' | 'keysAndIp' | 'wallet' | 'recipients';
export interface Check {
  key: CheckKey;
  ok: boolean;
  required: boolean;
  detail: string;
}
export interface ReadinessReport {
  ready: boolean;
  enabled: boolean;
  checkedAt: string;
  checks: Check[];
  balance: { naira: number | null; minimum: number; warnAt: number | null; asOf: string | null };
  observed: { peakHour7d: number; peakDay7d: number };
}

/** A clock, injectable only by tests. */
export const READINESS_CLOCK = Symbol('READINESS_CLOCK');

const CACHE_MS = 60_000;
const LAST_GOOD_MS = 5 * 60_000;
const NEEDED: AlertType[] = [AlertType.AML_SANCTIONS, AlertType.AML_REVIEW, AlertType.DOJAH_CONFIG];

/**
 * Whether Basic may call Dojah at all (spec §12.2, §14.2). Cached for 60 s so
 * the free balance call is never made per submission; fails closed when Dojah
 * cannot be reached and the last good balance is over 5 minutes old.
 */
@Injectable()
export class DojahReadinessService implements Readiness {
  private cached: { at: number; report: ReadinessReport } | null = null;
  private lastGood: { at: number; naira: number } | null = null;
  private override: { reason: 'wallet' | 'keys'; at: number } | null = null;
  private readonly now: () => number;

  constructor(
    private readonly cfg: DojahConfig,
    private readonly dojah: DojahApi,
    private readonly recipients: AlertRecipientsService,
    private readonly alerts: OpsAlertsService,
    private readonly prisma: PrismaService,
    @Optional() @Inject(READINESS_CLOCK) now?: () => number,
  ) {
    this.now = now ?? Date.now;
  }

  /** A paid call was just refused for the wallet or the keys: stop until the next good check. */
  markNotReady(reason: 'wallet' | 'keys'): void {
    this.override = { reason, at: this.now() };
    this.cached = null;
  }

  async assertReady(): Promise<void> {
    const r = await this.report();
    if (!r.ready) throw new Error('Dojah is not ready');
  }

  async report(refresh = false): Promise<ReadinessReport> {
    if (!refresh && !this.override && this.cached && this.now() - this.cached.at < CACHE_MS) return this.cached.report;
    // A refusal seen by a real call holds for one cache window, or until someone asks for a fresh check.
    if (this.override && (refresh || this.now() - this.override.at >= CACHE_MS)) this.override = null;
    const prod = this.cfg.nodeEnv === 'production';
    // The Dojah screen first, then api/.env.
    const settings = await this.cfg.effective();
    const checks: Check[] = [];

    const modeOk = !prod || (!this.cfg.useMock && new URL(this.cfg.baseUrl).hostname === 'api.dojah.io');
    checks.push({ key: 'mode', ok: modeOk, required: true, detail: modeOk ? 'Mode matches the environment' : 'Production must use the live Dojah URL with the mock off' });

    const credsOk = this.cfg.useMock || (await this.cfg.credentials().then(() => true, () => false));
    checks.push({ key: 'credentials', ok: credsOk, required: true, detail: credsOk ? 'App ID and secret key are set' : 'The Dojah app ID or secret key is missing' });

    let naira: number | null = null;
    let keysOk = this.cfg.useMock;
    let keysDetail = this.cfg.useMock ? 'Mock in use' : 'Not checked: credentials missing';
    if (!this.cfg.useMock && credsOk) {
      try {
        naira = await this.dojah.balance();
        this.lastGood = { at: this.now(), naira };
        keysOk = true;
        keysDetail = 'Keys accepted and this server is whitelisted';
      } catch (err) {
        const kind = err instanceof DojahError ? err.kind : 'UNKNOWN';
        if (kind === 'AUTH' || kind === 'IP') {
          keysDetail = 'Dojah refused the keys or IP whitelist';
        } else if (this.lastGood && this.now() - this.lastGood.at < LAST_GOOD_MS) {
          naira = this.lastGood.naira;
          keysOk = true;
          keysDetail = 'Dojah did not answer; using the balance from under 5 minutes ago';
        } else {
          keysDetail = 'We could not reach Dojah to check the keys and balance';
        }
      }
    }
    if (this.override?.reason === 'keys') {
      keysOk = false;
      keysDetail = 'A recent call was refused for keys or IP whitelist';
    }
    checks.push({ key: 'keysAndIp', ok: keysOk, required: true, detail: keysDetail });

    const minimum = settings.minBalance;
    let walletOk = this.cfg.useMock || (naira !== null && naira >= minimum);
    if (this.override?.reason === 'wallet') walletOk = false;
    checks.push({
      key: 'wallet',
      ok: walletOk,
      required: prod,
      detail: walletOk ? 'Wallet at or above the minimum' : naira === null ? 'Balance unknown' : 'Wallet below the minimum',
    });

    const missing: string[] = [];
    for (const t of NEEDED) if ((await this.recipients.resolve(t)).length === 0) missing.push(t);
    checks.push({
      key: 'recipients',
      ok: missing.length === 0,
      required: true,
      detail: missing.length ? `No one receives: ${missing.join(', ')}` : 'Every AML and Dojah alert has a recipient',
    });

    const ready = checks.every((c) => c.ok || !c.required);
    const warnAt = settings.lowBalanceWarn;
    if (!ready) {
      await this.alerts.raise(
        AlertType.DOJAH_CONFIG,
        'dojah:not-ready',
        'Basic verification is paused: Dojah is not ready',
        checks.filter((c) => c.required && !c.ok).map((c) => c.detail),
      );
    } else if (warnAt !== null && naira !== null && naira < warnAt) {
      await this.alerts.raise(AlertType.DOJAH_CONFIG, 'dojah:low-balance', 'Dojah wallet running low: top it up', [
        `Balance: ₦${naira}`,
        `Warn at: ₦${warnAt}`,
        `Hard stop: ₦${minimum}`,
      ]);
    }

    const report: ReadinessReport = {
      ready,
      enabled: settings.basicEnabled,
      checkedAt: new Date(this.now()).toISOString(),
      checks,
      balance: { naira, minimum, warnAt, asOf: this.lastGood ? new Date(this.lastGood.at).toISOString() : null },
      observed: await this.observed(),
    };
    this.cached = { at: this.now(), report };
    return report;
  }

  /** The busiest hour and Lagos day of the last week: the inputs to re-run plan §R2. */
  private async observed(): Promise<{ peakHour7d: number; peakDay7d: number }> {
    try {
      const [h] = await this.prisma.$queryRaw<{ peak: number }[]>`
        SELECT COALESCE(MAX(c), 0)::int AS peak FROM (
          SELECT COUNT(*) AS c FROM "kyc_verifications"
          WHERE "lookupStartedAt" > now() - interval '7 days'
          GROUP BY date_trunc('hour', "lookupStartedAt")) t`;
      const [d] = await this.prisma.$queryRaw<{ peak: number }[]>`
        SELECT COALESCE(MAX(c), 0)::int AS peak FROM (
          SELECT COUNT(*) AS c FROM "kyc_verifications"
          WHERE "lookupStartedAt" > now() - interval '7 days'
          GROUP BY "lagosDay") t`;
      return { peakHour7d: Number(h?.peak ?? 0), peakDay7d: Number(d?.peak ?? 0) };
    } catch {
      return { peakHour7d: 0, peakDay7d: 0 };
    }
  }
}
