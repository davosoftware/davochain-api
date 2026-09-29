import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import { PrismaService } from '../prisma/prisma.service';
import { CredentialsService } from './credentials.service';

/**
 * One transport, one log, for everything the API emails.
 *
 * Every send is written to EmailLog whether it worked or not — a silently
 * failed email is indistinguishable from one that was never sent, and both look
 * like nothing happening.
 */
@Injectable()
export class MailService {
  private readonly log = new Logger(MailService.name);
  private transporter: Transporter | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly credentials: CredentialsService,
  ) {}

  get isConfigured(): boolean {
    return Boolean(this.config.get<string>('SMTP_HOST'));
  }

  private async mailer(): Promise<Transporter | null> {
    if (this.transporter) return this.transporter;
    const host = this.config.get<string>('SMTP_HOST');
    if (!host) return null;

    // The password can be rotated from the admin; the host and user stay in
    // the environment because they are not secrets.
    const password =
      (await this.credentials.get('smtp.password').catch(() => undefined)) ??
      this.config.get<string>('SMTP_PASSWORD');

    this.transporter = createTransport({
      host,
      port: this.config.get<number>('SMTP_PORT') ?? 587,
      secure: this.config.get<boolean>('SMTP_SECURE') ?? false,
      auth: this.config.get<string>('SMTP_USER')
        ? { user: this.config.getOrThrow<string>('SMTP_USER'), pass: password ?? '' }
        : undefined,
    });
    return this.transporter;
  }

  /**
   * Returns whether it actually left the building.
   *
   * A caller that must not pretend otherwise — a password reset, say — can then
   * refuse rather than telling somebody to check an inbox nothing was sent to.
   */
  async send(message: {
    to: string;
    subject: string;
    text: string;
    html?: string;
    /** Which CMS template produced it, so the log can be read by event. */
    templateKey?: string;
  }): Promise<boolean> {
    const mailer = await this.mailer();
    if (!mailer) {
      this.log.warn(`SMTP not configured — would have emailed ${message.to}: ${message.subject}`);
      await this.prisma.emailLog
        .create({
          data: {
            to: message.to,
            subject: message.subject,
            templateKey: message.templateKey ?? null,
            succeeded: false,
            error: 'SMTP not configured',
          },
        })
        .catch(() => undefined);
      return false;
    }

    try {
      await mailer.sendMail({
        from: this.config.get<string>('SMTP_FROM'),
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      await this.prisma.emailLog.create({
        data: {
          to: message.to,
          subject: message.subject,
          templateKey: message.templateKey ?? null,
          succeeded: true,
        },
      });
      return true;
    } catch (err) {
      await this.prisma.emailLog
        .create({
          data: {
            to: message.to,
            subject: message.subject,
            templateKey: message.templateKey ?? null,
            succeeded: false,
            error: (err as Error).message,
          },
        })
        .catch(() => undefined);
      this.log.error(`Mail to ${message.to} failed: ${(err as Error).message}`);
      return false;
    }
  }
}
