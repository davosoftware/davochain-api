import { Injectable, Logger, Optional } from '@nestjs/common';
import { AlertRecipientsService } from './alert-recipients.service';
import { ConfigService } from '@nestjs/config';
import { AlertType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail.service';
import { redactIds } from '../redact';

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

  private readonly recipientsOf: AlertRecipientsService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
    @Optional() recipients?: AlertRecipientsService,
  ) {
    this.recipientsOf = recipients ?? new AlertRecipientsService(prisma, config);
  }

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

      const to = await this.recipientsOf.resolve(type);
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
}
