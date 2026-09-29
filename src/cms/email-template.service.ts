import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  EMAIL_TEMPLATES,
  SAMPLE_VALUES,
  allowedVariables,
  emailTemplate,
  type EmailTemplateDef,
} from './email-templates';
import { fillVariables, variablesUsed } from './markdown';
import { htmlToText, sanitiseHtml } from './sanitise';
import { wrapHtml, wrapText, type EmailBrand } from './email-layout';
import { SocialLinksService } from './social-links.service';
import { MailService } from '../common/mail.service';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Turns a stored template into a finished email.
 *
 * The admin writes a subject, a rich-text body and optionally a picture;
 * everything around it — the logo, the header band, the footer with the
 * company's real contact details — is added by the layout. That split is the
 * whole point: the frame is written once and corrected once, and no amount of
 * editing in the dashboard can produce an email that does not look like the
 * others.
 */
@Injectable()
export class EmailTemplateService {
  private readonly log = new Logger(EmailTemplateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
    private readonly socials: SocialLinksService,
  ) {}

  private base(): string {
    return (this.config.get<string>('PUBLIC_API_URL') ?? 'http://localhost:3000').replace(/\/$/, '');
  }

  /**
   * The brand block, read straight from the settings row.
   *
   * Deliberately not through SiteSettingsService: that lives in the admin
   * module, which needs to send email, and importing it here would make the two
   * modules depend on each other for the sake of some string columns. An email
   * needs a name, an address, a logo and a footer — not the upload validation
   * that comes with them.
   */
  private async brand(templateKey?: string): Promise<EmailBrand> {
    const [row, template, socials] = await Promise.all([
      this.prisma.siteSetting
        .findUnique({
          where: { id: 'default' },
          select: {
            companyName: true,
            supportEmail: true,
            address: true,
            logoType: true,
            logoUpdatedAt: true,
            emailLegalName: true,
            emailAddressLine: true,
            emailOptInNote: true,
            emailUnsubscribeNote: true,
            emailUnsubscribeUrl: true,
          },
        })
        .catch(() => null),
      templateKey
        ? this.prisma.emailTemplate
            .findUnique({
              where: { key: templateKey },
              select: { imageType: true, imageUpdatedAt: true, imageAlt: true },
            })
            .catch(() => null)
        : Promise.resolve(null),
      this.socials.enabled().catch(() => []),
    ]);

    const companyName = row?.companyName ?? 'Davochain';
    const base = this.base();

    return {
      companyName,
      supportEmail: row?.supportEmail ?? 'support@davochain.com',
      address: row?.address ?? null,

      // Absolute, always. A relative src resolves against the mail client's own
      // domain, so the logo silently never appears.
      logoUrl: row?.logoType
        ? `${base}/v1/site/logo?v=${row.logoUpdatedAt ? row.logoUpdatedAt.getTime() : 0}`
        : null,
      imageUrl:
        templateKey && template?.imageType
          ? `${base}/v1/site/email-image/${encodeURIComponent(templateKey)}?v=${template.imageUpdatedAt ? template.imageUpdatedAt.getTime() : 0}`
          : null,
      imageAlt: template?.imageAlt ?? null,

      social: socials,

      footer: {
        // Falls back to the company name rather than leaving the copyright line
        // blank — a footer reading "© 2026 . All rights reserved." looks broken.
        legalName: row?.emailLegalName?.trim() || companyName,
        addressLine: row?.emailAddressLine?.trim() || row?.address || null,
        optInNote:
          row?.emailOptInNote?.trim() ||
          'You are receiving this email because you have an account with us.',
        unsubscribeNote:
          row?.emailUnsubscribeNote?.trim() ||
          'If these emails get annoying, please feel free to',
        unsubscribeUrl: row?.emailUnsubscribeUrl?.trim() || null,
      },
    };
  }

  /**
   * The wording in force for a key: the admin's edit if there is one, otherwise
   * the default shipped in the catalogue.
   */
  async current(key: string): Promise<{
    def: EmailTemplateDef;
    subject: string;
    body: string;
    isActive: boolean;
    edited: boolean;
  } | null> {
    const def = emailTemplate(key);
    if (!def) return null;

    const row = await this.prisma.emailTemplate.findUnique({ where: { key } });
    return {
      def,
      subject: row?.subject ?? def.subject,
      body: row?.body ?? def.body,
      // A template nobody has touched is on. Requiring an admin to enable
      // twenty-two of them before a single welcome email works is a trap.
      isActive: row?.isActive ?? true,
      // Whether the WORDING differs, not whether a row exists — uploading a
      // picture creates a row without changing a word of the message.
      edited: row !== null && (row.subject !== def.subject || row.body !== def.body),
    };
  }

  /**
   * Render one, ready to send.
   *
   * Returns null when the template is switched off, which is the caller's cue
   * to skip silently rather than to log a failure — a disabled email is not an
   * error, it is a decision somebody made in the dashboard.
   */
  async render(
    key: string,
    variables: Record<string, string | null | undefined> = {},
    options: { ignoreActive?: boolean } = {},
  ): Promise<RenderedEmail | null> {
    const current = await this.current(key);
    if (!current) {
      this.log.warn(`No such email template: ${key}`);
      return null;
    }
    if (!current.isActive && !options.ignoreActive) return null;

    const brand = await this.brand(key);
    const values: Record<string, string | null | undefined> = {
      companyName: brand.companyName,
      supportEmail: brand.supportEmail,
      year: String(new Date().getFullYear()),
      ...variables,
    };

    const subject = fillVariables(current.subject, values).replace(/\s+/g, ' ').trim();
    /*
     * Sanitised after substitution, not before.
     *
     * The stored body was cleaned on write, but a value going into it is not —
     * a suspension reason is typed by an admin and a coin symbol comes off a
     * webhook. Running the finished document through the allowlist means no
     * placeholder can smuggle a tag into an email.
     */
    const filled = sanitiseHtml(fillVariables(current.body, values));

    return {
      subject,
      text: wrapText(htmlToText(filled), brand),
      html: wrapHtml(filled, brand),
    };
  }

  /**
   * Render the editor's contents with sample values, and optionally mail a copy.
   *
   * Previews what was typed rather than what is saved, which is the point: the
   * only way to catch a mangled placeholder or a broken link is to see the
   * finished email before every user does.
   */
  async preview(
    key: string,
    adminId: string,
    input: { subject?: string; body?: string; sendTo?: string },
  ) {
    const current = await this.current(key);
    if (!current) throw new NotFoundException(`There is no email template called "${key}"`);

    const subject = input.subject ?? current.subject;
    const body = input.body ?? current.body;
    const brand = await this.brand(key);

    const values: Record<string, string> = {
      ...SAMPLE_VALUES,
      companyName: brand.companyName,
      supportEmail: brand.supportEmail,
      year: String(new Date().getFullYear()),
    };

    const filled = sanitiseHtml(fillVariables(body, values));
    const rendered: RenderedEmail = {
      subject: fillVariables(subject, values).replace(/\s+/g, ' ').trim(),
      text: wrapText(htmlToText(filled), brand),
      html: wrapHtml(filled, brand),
    };

    // A placeholder the catalogue does not define is almost always a typo, and
    // it reaches users as literal braces. Worth saying so at the moment of
    // editing rather than after the first send.
    const unknown = variablesUsed(`${subject}\n${body}`).filter(
      (name) => !allowedVariables(key).includes(name),
    );

    let sent: boolean | null = null;
    if (input.sendTo) {
      const to = input.sendTo.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
        throw new BadRequestException('Enter a valid email address to send the test to');
      }
      // Deliberately bypasses isActive: testing a switched-off template before
      // turning it on is exactly when a preview is most useful.
      sent = await this.mail.send({
        to,
        subject: `[Test] ${rendered.subject}`,
        text: rendered.text,
        html: rendered.html,
        templateKey: key,
      });
      this.log.log(`Test of ${key} sent to ${to} by ${adminId}: ${sent ? 'ok' : 'not delivered'}`);
    }

    return {
      key,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      unknownVariables: unknown,
      allowedVariables: allowedVariables(key),
      sampleValues: values,
      sent,
      /** So the screen can say why a test did not arrive. */
      smtpConfigured: this.mail.isConfigured,
    };
  }

  /** Every template, with whether it has been edited. For the CMS screen. */
  async list() {
    const rows = await this.prisma.emailTemplate.findMany({
      // Never selects the image bytes. A list of twenty-two templates is not a
      // reason to read several megabytes off the disk.
      select: {
        key: true,
        subject: true,
        body: true,
        isActive: true,
        imageType: true,
        imageUpdatedAt: true,
        imageAlt: true,
        updatedAt: true,
        updatedBy: true,
      },
    });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const base = this.base();

    return EMAIL_TEMPLATES.map((def) => {
      const row = byKey.get(def.key);
      return {
        key: def.key,
        label: def.label,
        hint: def.hint,
        group: def.group,
        sentBy: def.sentBy,
        pending: def.pending ?? null,
        /** Sent with the list so the editor needs no call to show them. */
        variables: allowedVariables(def.key),
        subject: row?.subject ?? def.subject,
        body: row?.body ?? def.body,
        isActive: row?.isActive ?? true,
        edited: row !== undefined && (row.subject !== def.subject || row.body !== def.body),
        imageUrl: row?.imageType
          ? `${base}/v1/site/email-image/${encodeURIComponent(def.key)}?v=${row.imageUpdatedAt ? row.imageUpdatedAt.getTime() : 0}`
          : null,
        imageAlt: row?.imageAlt ?? null,
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
        defaultSubject: def.subject,
        defaultBody: def.body,
      };
    });
  }

  /**
   * Store an admin's edit.
   *
   * Lives here rather than in the controller so the sanitiser cannot be
   * forgotten by whoever adds the next route that writes a body.
   */
  async save(
    key: string,
    adminId: string,
    input: { subject?: string; body?: string; isActive?: boolean },
  ) {
    const current = await this.current(key);
    if (!current) throw new NotFoundException(`There is no email template called "${key}"`);

    return this.prisma.emailTemplate.upsert({
      where: { key },
      create: {
        key,
        subject: input.subject ?? current.subject,
        body: sanitiseHtml(input.body ?? current.body),
        isActive: input.isActive ?? true,
        updatedBy: adminId,
      },
      update: {
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.body !== undefined ? { body: sanitiseHtml(input.body) } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        updatedBy: adminId,
      },
      select: { key: true, subject: true, isActive: true, updatedAt: true, updatedBy: true },
    });
  }

  /** Back to the wording this install shipped with. Keeps the picture. */
  async reset(key: string) {
    await this.prisma.emailTemplate.updateMany({
      where: { key },
      data: {
        subject: emailTemplate(key)!.subject,
        body: emailTemplate(key)!.body,
      },
    });
    return this.current(key);
  }

  // ── the picture on an email ───────────────────────────────

  /** The bytes, for the public route a mail client fetches. */
  async image(key: string): Promise<{ bytes: Buffer; type: string; version: string }> {
    const row = await this.prisma.emailTemplate.findUnique({
      where: { key },
      select: { image: true, imageType: true, imageUpdatedAt: true },
    });
    if (!row?.image || !row.imageType) throw new NotFoundException('No image set');
    return {
      bytes: Buffer.from(row.image),
      type: row.imageType,
      version: String(row.imageUpdatedAt?.getTime() ?? 0),
    };
  }

  /**
   * Store a picture for one template.
   *
   * Checked by its first bytes rather than by the type it claims: a declared
   * content type is attacker-controlled, and this file is served to the public
   * so a mail client can fetch it. SVG is refused here even though the site
   * logo allows it — no mail client renders SVG, so accepting one would only
   * produce an email with a hole in it.
   */
  async setImage(
    key: string,
    dataUrl: string,
    alt: string | undefined,
    adminId: string,
  ): Promise<{ imageUrl: string; imageAlt: string | null }> {
    const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(dataUrl.trim());
    if (!match) throw new BadRequestException('That does not look like an image');

    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new BadRequestException(
        `That image is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB. The limit is 2 MB — a picture bigger than that gets an email flagged as spam before anyone reads it.`,
      );
    }

    const type = detectImageType(bytes);
    if (!type) {
      throw new BadRequestException('Use a PNG, JPEG or GIF. Mail clients do not render SVG.');
    }

    const row = await this.prisma.emailTemplate.upsert({
      where: { key },
      create: {
        key,
        subject: emailTemplate(key)!.subject,
        body: emailTemplate(key)!.body,
        image: bytes,
        imageType: type,
        imageUpdatedAt: new Date(),
        imageAlt: alt?.trim() || null,
        updatedBy: adminId,
      },
      update: {
        image: bytes,
        imageType: type,
        imageUpdatedAt: new Date(),
        ...(alt !== undefined ? { imageAlt: alt.trim() || null } : {}),
        updatedBy: adminId,
      },
      select: { imageUpdatedAt: true, imageAlt: true },
    });

    return {
      imageUrl: `${this.base()}/v1/site/email-image/${encodeURIComponent(key)}?v=${row.imageUpdatedAt?.getTime() ?? 0}`,
      imageAlt: row.imageAlt,
    };
  }

  async clearImage(key: string, adminId: string): Promise<{ cleared: true }> {
    await this.prisma.emailTemplate.updateMany({
      where: { key },
      data: { image: null, imageType: null, imageUpdatedAt: null, imageAlt: null, updatedBy: adminId },
    });
    return { cleared: true };
  }
}

/** 2 MB. Past that, mail providers start treating a message as suspicious. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * What a file *is*, not what it claims to be.
 *
 * Only the three formats every mail client renders. SVG is excluded on purpose:
 * Gmail, Outlook and Apple Mail all refuse it, so an SVG banner is a blank
 * space in every inbox that matters.
 */
function detectImageType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  return null;
}
