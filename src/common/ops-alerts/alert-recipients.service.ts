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
  AlertType.DOJAH_CONFIG,
  AlertType.AML_REVIEW,
  AlertType.AML_SANCTIONS,
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
  NAIRA_RAIL_CONFIG: { label: 'Naira rail setup problem', description: 'Payrep refused our keys or setup, or queued a transfer for approval; naira payouts or deposits may stop.' },
  NAIRA_WEBHOOK_REJECTED: { label: 'Naira webhook refused', description: 'Payrep webhooks arrived with a wrong signature or an old timestamp, 3 or more in an hour.' },
  NGN_DEPOSIT_UNMATCHED: { label: 'Unmatched naira deposit', description: 'Money arrived that could not be matched to a customer.' },
  NGN_RECONCILIATION: { label: 'Naira reconciliation', description: 'A naira deposit or sweep needs attention.' },
  VIRTUAL_ACCOUNT_SYNC: { label: 'Virtual account sync', description: 'A customer deposit account could not be kept in step with Flutterwave.' },
  ADMIN_LOCKOUT: { label: 'Admin account locked', description: 'An admin account was locked after repeated wrong passwords; someone may be guessing it.' },
  RATE_LIMIT_DEGRADED: { label: 'Rate limiting degraded', description: 'Redis is unreachable: sign-in is refusing requests and other routes run without limits.' },
  DOJAH_CONFIG: { label: 'Verification provider problem', description: 'Dojah refused our keys, IP or wallet, or stopped answering; Basic verification is paused.' },
  AML_REVIEW: { label: 'AML review needed', description: 'A verification matched a PEP, adverse-media or unclear AML result and waits for a compliance reviewer.' },
  AML_SANCTIONS: { label: 'Sanctions match', description: 'A possible or confirmed sanctions match. Confirmed matches are blocked automatically and need an owner.' },
  TREASURY_SHORT: { label: 'Naira short', description: 'The daily Treasury check: customers are owed more naira than we hold at the naira rail and Quidax together.' },
  TREASURY_RESERVE_LOW: { label: 'Payout reserve low', description: 'The naira at the naira rail has dropped below the payout reserve, so customer withdrawals may run short. Top it up.' },
  PAYOUT_REVERSED: { label: 'Payout reversed', description: 'Payrep reversed a transfer that had succeeded. Nothing is changed automatically: check where the money is.' },
  DEPOSIT_REVERSED: { label: 'Deposit reversed', description: 'Payrep reversed a deposit that had succeeded. Nothing is clawed back automatically: review the customer balance.' },
};

/** Who made a change, for the audit row written in the same transaction. */
export interface AuditActor {
  adminId: string;
  ip?: string;
}

export interface RecipientsView {
  /** False when ALERT_DEFAULT_RECIPIENTS is empty: a type on the fallback then reaches nobody. */
  fallbackConfigured: boolean;
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
      fallbackConfigured: (this.config.get<string[]>('ALERT_DEFAULT_RECIPIENTS') ?? []).length > 0,
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

  async add(type: AlertType, email: string, actor?: AuditActor): Promise<AlertRecipient> {
    const clean = email.trim().toLowerCase();
    return this.lockedFor(type, async (tx) => {
      const existing = await tx.alertRecipient.findFirst({ where: { type, email: clean } });
      if (existing) throw new ConflictException('That email already receives this alert');
      const row = await tx.alertRecipient.create({ data: { type, email: clean } });
      await this.audit(tx, actor, 'alert_recipient.add', row.id, null, row);
      return row;
    });
  }

  async setEnabled(
    id: string,
    enabled: boolean,
    actor?: AuditActor,
  ): Promise<{ before: AlertRecipient; after: AlertRecipient }> {
    const found = await this.mustFind(this.prisma, id);
    return this.lockedFor(found.type, async (tx) => {
      const before = await this.mustFind(tx, id);
      if (!enabled) await this.refuseIfLastSecurityRecipient(tx, before);
      const after = await tx.alertRecipient.update({ where: { id }, data: { enabled } });
      await this.audit(tx, actor, enabled ? 'alert_recipient.enable' : 'alert_recipient.disable', id, before, after);
      return { before, after };
    });
  }

  async remove(id: string, actor?: AuditActor): Promise<AlertRecipient> {
    const found = await this.mustFind(this.prisma, id);
    return this.lockedFor(found.type, async (tx) => {
      const row = await this.mustFind(tx, id);
      await this.refuseIfLastSecurityRecipient(tx, row);
      await tx.alertRecipient.delete({ where: { id } });
      await this.audit(tx, actor, 'alert_recipient.remove', id, row, null);
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

  /**
   * The audit row is written with the same transaction as the change, so a
   * change without its audit row cannot commit (final review m3).
   */
  private async audit(
    tx: Tx,
    actor: AuditActor | undefined,
    action: string,
    id: string,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    if (!actor) return;
    await tx.adminAuditLog.create({
      data: {
        adminUserId: actor.adminId,
        action,
        entity: 'AlertRecipient',
        entityId: id,
        before: (before ?? null) as never,
        after: (after ?? null) as never,
        ip: actor.ip ?? null,
      },
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
