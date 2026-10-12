import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlertType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail.service';
import { redactIds } from '../../flutterwave/flutterwave.errors';

const HOUR = 3_600_000;

/**
 * Operational alerts: one Alert row (the record and the
 * dedupe key, held in `assetCode`) and one email per recipient.
 *
 * Two rules. It never throws, because an alert that fails must not fail the
 * deposit that raised it. And every word is redacted, because an inbox is the
 * last place a BVN should end up.
 */
@Injectable()
export class OpsAlertsService {
  private readonly log = new Logger(OpsAlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  /** True when it went out; false when it was a repeat inside the cooldown, or could not be raised. */
  async raise(
    type: AlertType,
    key: string,
    subject: string,
    lines: string[],
    cooldownMs = HOUR,
  ): Promise<boolean> {
    try {
      const last = await this.prisma.alert.findFirst({
        where: { type, assetCode: key },
        orderBy: { sentAt: 'desc' },
      });
      if (last && Date.now() - last.sentAt.getTime() < cooldownMs) return false;

      const safeSubject = redactIds(subject);
      const safeLines = lines.map((l) => redactIds(l));
      await this.prisma.alert.create({
        data: { type, assetCode: key, payload: { subject: safeSubject, lines: safeLines } },
      });

      const to = await this.recipients(type);
      if (to.length === 0) {
        this.log.warn(`No recipients for ${type}: ${safeSubject}`);
        return true;
      }
      const text = [safeSubject, '', ...safeLines].join('\n');
      for (const address of to) {
        await this.mail.send({ to: address, subject: `[DavoChain] ${safeSubject}`, text });
      }
      return true;
    } catch (err) {
      this.log.error(`Could not raise a ${type} alert: ${redactIds((err as Error).message)}`);
      return false;
    }
  }

  private async recipients(type: AlertType): Promise<string[]> {
    const rows = await this.prisma.alertRecipient.findMany({ where: { type, enabled: true } });
    if (rows.length > 0) return rows.map((r) => r.email);
    return this.config.get<string[]>('ALERT_DEFAULT_RECIPIENTS') ?? [];
  }
}
