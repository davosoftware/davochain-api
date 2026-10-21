import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlertType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FlutterwaveClient } from '../flutterwave/flutterwave.client';
import { FlutterwaveConfig } from '../flutterwave/flutterwave.config';
import { FlutterwaveError, redactIds } from '../flutterwave/flutterwave.errors';
import { OpsAlertsService } from '../common/ops-alerts/ops-alerts.service';

const CACHE_MS = 60_000;

export interface ReadinessCheck {
  key: 'mockOff' | 'secretKey' | 'secretHash' | 'reachable' | 'lastWebhook';
  label: string;
  ok: boolean;
  /** Required checks gate new virtual accounts; the rest are information. */
  required: boolean;
  detail: string | null;
}

export interface ReadinessReport {
  mode: 'MOCK' | 'TEST' | 'LIVE';
  depositsEnabled: boolean;
  canCreateAccounts: boolean;
  checks: ReadinessCheck[];
  /** Flutterwave's NGN balance, read-only. Null when it could not be read. */
  balance: { currency: string; available: string; ledger: string } | null;
  lastWebhookAt: string | null;
  /** Where Flutterwave must send webhooks, relative to the API's public origin. */
  webhookPath: string;
  checkedAt: string;
}

/**
 * Is the naira rail safe to open accounts on?
 *
 * Spec §6.3 checks 1–4 gate account creation: mock off, a key allowed in this
 * environment, a webhook hash, and Flutterwave answering our key. The one
 * exception is the development mock, which may open (fake) accounts so the
 * whole flow can be exercised locally. Cached for a minute, because the app
 * asks on every account screen.
 */
@Injectable()
export class ReadinessService {
  private cached: { at: number; report: ReadinessReport } | null = null;
  /** The check under way, if any: concurrent callers share it instead of each asking Flutterwave. */
  private building: Promise<ReadinessReport> | null = null;

  constructor(
    private readonly cfg: FlutterwaveConfig,
    private readonly client: FlutterwaveClient,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly alerts: OpsAlertsService,
  ) {}

  get depositsEnabled(): boolean {
    return this.config.get<boolean>('NGN_DEPOSITS_ENABLED') === true;
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
    const hash = await this.cfg.secretHash().catch(() => null);
    const keyUsable = mock || (key.present && !key.problem);

    if (!mock && key.problem) {
      await this.alerts.raise(AlertType.NAIRA_RAIL_CONFIG, 'config', 'Flutterwave key refused by the key-mode guard', [key.problem]);
    }

    let balance: ReadinessReport['balance'] = null;
    let reachableDetail: string | null = null;
    if (keyUsable) {
      try {
        // A probe: one attempt, a few seconds at most, so a slow Flutterwave can't
        // hold the account screen or spend the rate limit deposits need.
        const b = await this.client.getBalance('NGN', { probe: true });
        balance = { currency: b.currency, available: b.available_balance, ledger: b.ledger_balance };
      } catch (err) {
        reachableDetail = redactIds((err as Error).message);
        if (err instanceof FlutterwaveError && err.kind === 'CONFIG') {
          await this.alerts.raise(AlertType.NAIRA_RAIL_CONFIG, 'config', 'Flutterwave refused our credentials', [reachableDetail]);
        }
      }
    } else {
      reachableDetail = 'Skipped: there is no usable secret key';
    }

    const last = await this.prisma.webhookEvent.findFirst({
      where: { eventName: { startsWith: 'flutterwave.' }, signatureValid: true },
      orderBy: { receivedAt: 'desc' },
    });

    const checks: ReadinessCheck[] = [
      {
        key: 'mockOff',
        label: 'The Flutterwave mock is off',
        ok: !mock,
        required: true,
        detail: mock ? 'FLW_USE_MOCK=true: development and test only' : null,
      },
      {
        key: 'secretKey',
        label: 'A secret key allowed in this environment',
        ok: keyUsable,
        required: true,
        detail: mock ? 'Not used by the mock' : !key.present ? 'Not set' : key.problem,
      },
      {
        key: 'secretHash',
        label: 'The webhook secret hash is set',
        ok: Boolean(hash),
        required: true,
        detail: hash ? null : 'Not set: every webhook will be rejected',
      },
      {
        key: 'reachable',
        label: 'Flutterwave answers our key',
        ok: balance !== null,
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
      webhookPath: '/webhooks/flutterwave',
      checkedAt: new Date().toISOString(),
    };
  }
}
