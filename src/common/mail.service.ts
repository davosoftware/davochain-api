import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
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
  /** The server, port, secure flag, user and password the current transporter was built with. */
  private builtWith = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly credentials: CredentialsService,
    /**
     * Read lazily: ServerSettingsService emails owners through this service, so
     * the two must not need each other at start-up (spec 2026-10-26).
     */
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  /** The mail server details that apply now: System → Server settings, else .env. */
  private smtp<T>(key: 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_SECURE' | 'SMTP_USER' | 'SMTP_FROM'): T | undefined {
    let settings: { get<V>(k: string): V } | null = null;
    try {
      // Loaded here, not at the top: server-settings.service imports this file (no import loop at start-up).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ServerSettingsService } = require('../settings/server-settings.service') as typeof import('../settings/server-settings.service');
      settings = this.moduleRef?.get(ServerSettingsService, { strict: false }) ?? null;
    } catch {
      settings = null;
    }
    return settings ? settings.get<T>(key as never) : this.config.get<T>(key);
  }

  get isConfigured(): boolean {
    return Boolean(this.smtp<string>('SMTP_HOST'));
  }

  private async mailer(): Promise<Transporter | null> {
    const host = this.smtp<string>('SMTP_HOST');
    if (!host) return null;

    // The password can be rotated from the admin; the host and user stay in
    // the environment because they are not secrets.
    const password =
      (await this.credentials.get('smtp.password').catch(() => undefined)) ??
      this.config.get<string>('SMTP_PASSWORD');

    const port = this.smtp<number>('SMTP_PORT') ?? 587;
    const secure = this.smtp<boolean>('SMTP_SECURE') ?? false;
    const user = this.smtp<string>('SMTP_USER');
    // Rebuilt only when something it was built with changed (a change on the Server settings or API keys screen).
    const signature = JSON.stringify([host, port, secure, user ?? '', password ?? '']);
    if (this.transporter && signature === this.builtWith) return this.transporter;
    this.builtWith = signature;

    this.transporter = createTransport({
      host,
      port,
      secure,
      auth: user ? { user, pass: password ?? '' } : undefined,
      // A mail server that never answers fails in seconds, not nodemailer's default 2 minutes.
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
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
    /** Inline pictures (the logo), referenced from the HTML as cid:… */
    attachments?: Array<{ filename: string; content: Buffer; contentType: string; cid: string }>;
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
        from: this.smtp<string>('SMTP_FROM'),
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        attachments: message.attachments,
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
