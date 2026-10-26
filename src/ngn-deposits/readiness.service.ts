import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlertType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { redactIds } from '../common/redact';
import { OpsAlertsService } from '../common/ops-alerts/ops-alerts.service';
import { PayrepApi } from '../payrep/payrep.api';
import { PayrepConfig } from '../payrep/payrep.config';
import { PayrepError } from '../payrep/payrep.errors';
import { ServerSettingsService } from '../settings/server-settings.service';

const CACHE_MS = 60_000;
/** How long the account screen waits for Payrep before calling it unreachable. */
const PROBE_MS = 5_000;

export interface ReadinessCheck {
  key: 'mockOff' | 'credentials' | 'webhookSecret' | 'mainAccount' | 'reachable' | 'lastWebhook';
  label: string;
  ok: boolean;
  /** Required checks gate new deposit accounts; the rest are information. */
  required: boolean;
  detail: string | null;
}

export interface ReadinessReport {
  mode: 'MOCK' | 'TEST' | 'LIVE';
  depositsEnabled: boolean;
  canCreateAccounts: boolean;
  checks: ReadinessCheck[];
  /** Our Payrep main account balance, read-only. Null when it could not be read. */
  balance: { currency: string; available: string; ledger: string } | null;
  lastWebhookAt: string | null;
  /** Where Payrep must send webhooks, relative to the API's public origin. */
  webhookPath: string;
  checkedAt: string;
}

/**
 * Is the naira rail safe to open deposit accounts on? (spec 2026-10-20 §8)
 *
 * Required: the mock off, keys allowed in this environment, the webhook
 * signing secret, our main account, and Payrep answering about that account
 * with it active. The one exception is the development mock, which may open
 * (fake) accounts so the whole flow can be exercised locally. Cached for a
 * minute, because the app asks on every account screen.
 */
@Injectable()
export class ReadinessService {
  private cached: { at: number; report: ReadinessReport } | null = null;
  /** The check under way, if any: concurrent callers share it instead of each asking Payrep. */
  private building: Promise<ReadinessReport> | null = null;

  constructor(
    private readonly cfg: PayrepConfig,
    private readonly payrep: PayrepApi,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly alerts: OpsAlertsService,
    /** Live values from System → Server settings (spec 2026-10-26); .env when absent. */
    @Optional() private readonly settings?: ServerSettingsService,
  ) {}

  get depositsEnabled(): boolean {
    return (this.settings ? this.settings.get<boolean>('NGN_DEPOSITS_ENABLED') : this.config.get<boolean>('NGN_DEPOSITS_ENABLED')) === true;
  }

  async report(force = false): Promise<ReadinessReport> {
    if (!force && this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.report;
    if (!this.building) {
      this.building = this.build()
        .then((report) => {
          this.cached = { at: Date.now(), report };
          return report;
        })
        .finally(() => {
          this.building = null;
        });
    }
    return this.building;
  }

  private async build(): Promise<ReadinessReport> {
    const mock = this.cfg.useMock;
    const key = await this.cfg.keyStatus();
    const secret = await this.cfg.webhookSecret().catch(() => null);
    const main = this.cfg.mainAccount;
    const keyUsable = mock || (key.present && !key.problem);
    const secretOk = Boolean(secret && /^[0-9a-f]{64}$/i.test(secret));

    if (!mock && key.problem) {
      await this.alerts.raise(AlertType.NAIRA_RAIL_CONFIG, 'config', 'Payrep keys refused by the key-mode guard', [key.problem]);
    }

    let balance: ReadinessReport['balance'] = null;
    let reachable = false;
    let reachableDetail: string | null = null;
    if (!keyUsable) {
      reachableDetail = 'Skipped: there are no usable keys';
    } else if (!main) {
      reachableDetail = 'Skipped: PAYREP_MAIN_ACCOUNT is not set';
    } else {
      try {
        const a = await this.probe(main);
        balance = { currency: 'NGN', available: a.balance, ledger: a.balance };
        reachable = a.status === 'active';
        if (!reachable) reachableDetail = `Payrep reports our main account as "${a.status || 'no status'}"`;
      } catch (err) {
        reachableDetail = redactIds((err as Error).message);
        if (err instanceof PayrepError && err.kind === 'CONFIG') {
          await this.alerts.raise(AlertType.NAIRA_RAIL_CONFIG, 'config', 'Payrep refused our keys', [reachableDetail]);
        }
      }
    }

    const last = await this.prisma.webhookEvent.findFirst({
      where: { eventName: { startsWith: 'payrep.' }, signatureValid: true },
      orderBy: { receivedAt: 'desc' },
    });

    const checks: ReadinessCheck[] = [
      {
        key: 'mockOff',
        label: 'The pretend Payrep is off',
        ok: !mock,
        required: true,
        detail: mock ? 'PAYREP_USE_MOCK=true: no real money moves (development and test only)' : null,
      },
      {
        key: 'credentials',
        label: 'Payrep keys allowed in this environment',
        ok: keyUsable,
        required: true,
        detail: mock ? 'Not used by the mock' : !key.present ? 'Not set: paste the Payrep client ID and secret in System → API keys, or in api/.env' : key.problem,
      },
      {
        key: 'webhookSecret',
        label: 'The webhook signing secret is set',
        ok: secretOk,
        required: true,
        detail: secretOk ? null : 'Not set (or not 64 characters): every Payrep webhook will be refused',
      },
      {
        key: 'mainAccount',
        label: 'Our Payrep main account is set',
        ok: mock || Boolean(main),
        required: true,
        detail: main ? `ending ${main.slice(-4)}` : 'Not set: put the 10-digit number in PAYREP_MAIN_ACCOUNT',
      },
      {
        key: 'reachable',
        label: 'Payrep answers our keys, and our main account is active',
        ok: reachable,
        required: true,
        detail: reachableDetail,
      },
      {
        key: 'lastWebhook',
        label: 'Last authenticated webhook',
        ok: Boolean(last),
        required: false,
        detail: last ? last.receivedAt.toISOString() : 'None yet',
      },
    ];

    const devMock = mock && ['development', 'test'].includes(this.cfg.nodeEnv);
    const coreOk = checks.filter((c) => c.required && c.key !== 'mockOff').every((c) => c.ok);
    return {
      mode: mock ? 'MOCK' : this.cfg.nodeEnv === 'production' ? 'LIVE' : 'TEST',
      depositsEnabled: this.depositsEnabled,
      canCreateAccounts: this.depositsEnabled && coreOk && (!mock || devMock),
      checks,
      balance,
      lastWebhookAt: last ? last.receivedAt.toISOString() : null,
      webhookPath: '/webhooks/payrep',
      checkedAt: new Date().toISOString(),
    };
  }

  /** One look at our main account, given up on after a few seconds so a slow Payrep can't hold the screen. */
  private async probe(main: string) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Payrep did not answer within ${PROBE_MS / 1000} seconds`)), PROBE_MS);
    });
    try {
      return await Promise.race([this.payrep.account(main), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
