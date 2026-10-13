import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlertType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Alerts that tell someone the platform is being attacked or has lost a
 * protection. They may never be left with no enabled recipient (spec §3.3).
 */
export const SECURITY_ALERT_TYPES: ReadonlySet<AlertType> = new Set<AlertType>([
  AlertType.ADMIN_LOCKOUT,
  AlertType.RATE_LIMIT_DEGRADED,
]);

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
}
