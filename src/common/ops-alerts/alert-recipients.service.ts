import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlertRecipient, AlertType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Alerts that tell someone the platform is being attacked or has lost a
 * protection. They may never be left with no enabled recipient (spec §3.3).
 */
export const SECURITY_ALERT_TYPES: ReadonlySet<AlertType> = new Set<AlertType>([
  AlertType.ADMIN_LOCKOUT,
  AlertType.RATE_LIMIT_DEGRADED,
]);

const LAST_SECURITY_RECIPIENT = 'This is the last enabled recipient of a security alert. Add another first.';

/** What each alert means, shown on the dashboard. Record<> keeps it complete as types are added. */
const CATALOGUE: Record<AlertType, { label: string; description: string }> = {
  REFILL_NEEDED: { label: 'Coin refill needed', description: 'A coin balance in the trading float is running low and needs topping up.' },
  PRICE_DIP: { label: 'Price dip', description: 'A coin price fell sharply; check margins and open quotes.' },
  COIN_EMPTY: { label: 'Coin empty', description: 'A coin balance in the float hit zero; sales of it will fail.' },
  NGN_FUEL_LOW: { label: 'Naira float low', description: 'The naira balance used for payouts is getting low.' },
  NGN_FUEL_CRITICAL: { label: 'Naira float critical', description: 'The naira payout balance is nearly empty; payouts are about to fail.' },
  RECONCILIATION_DRIFT: { label: 'Reconciliation drift', description: 'Our ledger and the provider balances disagree beyond tolerance.' },
  DAILY_DIGEST: { label: 'Daily digest', description: 'The morning summary of the previous day.' },
  MONTHLY_REPORT: { label: 'Monthly report', description: 'The month-end summary report.' },
  FLUTTERWAVE_CONFIG: { label: 'Flutterwave setup problem', description: 'Flutterwave refused our credentials or configuration; naira deposits may stop.' },
  FLUTTERWAVE_WEBHOOK_REJECTED: { label: 'Flutterwave webhook rejected', description: 'A webhook arrived with a missing or wrong secret hash.' },
  NGN_DEPOSIT_UNMATCHED: { label: 'Unmatched naira deposit', description: 'Money arrived that could not be matched to a customer.' },
  NGN_RECONCILIATION: { label: 'Naira reconciliation', description: 'A naira deposit or sweep needs attention.' },
  VIRTUAL_ACCOUNT_SYNC: { label: 'Virtual account sync', description: 'A customer deposit account could not be kept in step with Flutterwave.' },
  ADMIN_LOCKOUT: { label: 'Admin account locked', description: 'An admin account was locked after repeated wrong passwords; someone may be guessing it.' },
  RATE_LIMIT_DEGRADED: { label: 'Rate limiting degraded', description: 'Redis is unreachable: sign-in is refusing requests and other routes run without limits.' },
};

export interface RecipientsView {
  types: Array<{
    type: AlertType;
    label: string;
    description: string;
    security: boolean;
    usingEnvFallback: boolean;
    recipients: AlertRecipient[];
  }>;
}

type Tx = Prisma.TransactionClient;

/**
 * Who each alert goes to. The one place both alert services ask.
 *
 * Enabled database rows for the type win. With none, ALERT_DEFAULT_RECIPIENTS
 * from the environment. With neither, nobody, and the caller logs that.
 */
@Injectable()
export class AlertRecipientsService {
  constructor(
    protected readonly prisma: PrismaService,
    protected readonly config: ConfigService,
  ) {}

  async resolve(type: AlertType): Promise<string[]> {
    const rows = await this.prisma.alertRecipient.findMany({ where: { type, enabled: true } });
    if (rows.length > 0) return rows.map((r) => r.email);
    return this.config.get<string[]>('ALERT_DEFAULT_RECIPIENTS') ?? [];
  }

  async list(): Promise<RecipientsView> {
    const rows = await this.prisma.alertRecipient.findMany({ orderBy: { email: 'asc' } });
    return {
      types: (Object.values(AlertType) as AlertType[]).map((type) => {
        const recipients = rows.filter((r) => r.type === type);
        return {
          type,
          ...CATALOGUE[type],
          security: SECURITY_ALERT_TYPES.has(type),
          usingEnvFallback: !recipients.some((r) => r.enabled),
          recipients,
        };
      }),
    };
  }

  async add(type: AlertType, email: string): Promise<AlertRecipient> {
    const clean = email.trim().toLowerCase();
    return this.lockedFor(type, async (tx) => {
      const existing = await tx.alertRecipient.findFirst({ where: { type, email: clean } });
      if (existing) throw new ConflictException('That email already receives this alert');
      return tx.alertRecipient.create({ data: { type, email: clean } });
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<{ before: AlertRecipient; after: AlertRecipient }> {
    const found = await this.mustFind(this.prisma, id);
    return this.lockedFor(found.type, async (tx) => {
      const before = await this.mustFind(tx, id);
      if (!enabled) await this.refuseIfLastSecurityRecipient(tx, before);
      const after = await tx.alertRecipient.update({ where: { id }, data: { enabled } });
      return { before, after };
    });
  }

  async remove(id: string): Promise<AlertRecipient> {
    const found = await this.mustFind(this.prisma, id);
    return this.lockedFor(found.type, async (tx) => {
      const row = await this.mustFind(tx, id);
      await this.refuseIfLastSecurityRecipient(tx, row);
      await tx.alertRecipient.delete({ where: { id } });
      return row;
    });
  }

  /**
   * Changes to one alert type's recipients run one at a time: a transaction
   * holding a Postgres advisory lock keyed by the type. Two admins removing
   * the last two recipients at once cannot both see "one other remains".
   */
  private lockedFor<T>(type: AlertType, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx: Tx) => {
      await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtext(${`alert_recipients:${type}`}))`;
      return fn(tx);
    });
  }

  private async mustFind(db: Pick<Tx, 'alertRecipient'>, id: string): Promise<AlertRecipient> {
    const row = await db.alertRecipient.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('No such alert recipient');
    return row;
  }

  private async refuseIfLastSecurityRecipient(tx: Tx, row: AlertRecipient): Promise<void> {
    if (!SECURITY_ALERT_TYPES.has(row.type) || !row.enabled) return;
    const enabled = await tx.alertRecipient.findMany({ where: { type: row.type, enabled: true } });
    if (enabled.length <= 1) throw new ConflictException(LAST_SECURITY_RECIPIENT);
  }
}
