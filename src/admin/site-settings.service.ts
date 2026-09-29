import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** 1 MB. A logo is a few KB; this only stops somebody uploading a poster. */
const MAX_LOGO_BYTES = 1024 * 1024;

/**
 * What a file *is*, not what it claims to be. SVG is accepted here and not for
 * avatars, because a brand mark is usually vector and this one is uploaded by
 * an owner rather than by the public — but it is still served with a content
 * type that stops a browser executing anything inside it.
 */
const SIGNATURES: { type: string; test: (b: Buffer) => boolean }[] = [
  {
    type: 'image/png',
    test: (b) =>
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { type: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    type: 'image/webp',
    test: (b) =>
      b.subarray(0, 4).toString('ascii') === 'RIFF' &&
      b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  {
    type: 'image/svg+xml',
    test: (b) => /^\s*(<\?xml[^>]*\?>\s*)?(<!--.*?-->\s*)*<svg[\s>]/is.test(b.subarray(0, 512).toString('utf8')),
  },
];

const SINGLETON = 'default';

/**
 * URL fields still edited here.
 *
 * The six social columns used to be on this list. They are rows in SocialLink
 * now — each with its own icon and an on/off switch — and nothing reads the
 * columns, so writing to them would only produce two sources of truth.
 */
const URL_FIELDS = ['iosStoreUrl', 'androidStoreUrl'] as const;

export interface SiteSettingsInput {
  companyName?: string;
  supportEmail?: string;
  phone?: string | null;
  address?: string | null;
  iosVersion?: string | null;
  androidVersion?: string | null;
  iosStoreUrl?: string | null;
  androidStoreUrl?: string | null;
  maintenanceMode?: boolean;
  maintenanceMessage?: string | null;

  /** The footer on every email. See EmailBrand in cms/email-layout.ts. */
  emailLegalName?: string | null;
  emailAddressLine?: string | null;
  emailOptInNote?: string | null;
  emailUnsubscribeNote?: string | null;
  emailUnsubscribeUrl?: string | null;
}

/**
 * The one row every public surface reads.
 *
 * The website, the apps and the admin all take their contact details, store
 * links and social handles from here, so a phone number is changed in one place
 * and is right everywhere — rather than being hard-coded into a landing page
 * that then needs a deploy to correct a typo.
 */
@Injectable()
export class SiteSettingsService {
  private readonly log = new Logger(SiteSettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Creates the row on first read, so a fresh install has defaults, not a 404. */
  private async row() {
    return this.prisma.siteSetting.upsert({
      where: { id: SINGLETON },
      create: { id: SINGLETON },
      update: {},
    });
  }

  async get() {
    const s = await this.row();
    return {
      companyName: s.companyName,
      supportEmail: s.supportEmail,
      phone: s.phone,
      address: s.address,
      iosVersion: s.iosVersion,
      androidVersion: s.androidVersion,
      iosStoreUrl: s.iosStoreUrl,
      androidStoreUrl: s.androidStoreUrl,
      maintenanceMode: s.maintenanceMode,
      maintenanceMessage: s.maintenanceMessage,
      emailLegalName: s.emailLegalName,
      emailAddressLine: s.emailAddressLine,
      emailOptInNote: s.emailOptInNote,
      emailUnsubscribeNote: s.emailUnsubscribeNote,
      emailUnsubscribeUrl: s.emailUnsubscribeUrl,
      hasLogo: s.logoType !== null,
      logoVersion: s.logoUpdatedAt ? String(s.logoUpdatedAt.getTime()) : null,
      updatedAt: s.updatedAt,
      updatedBy: s.updatedBy,
    };
  }

  /**
   * A URL a browser will follow, or nothing.
   *
   * Only http and https. A `javascript:` link rendered into the website's
   * footer is a script the operator did not write, and this field is echoed to
   * every visitor.
   */
  private cleanUrl(value: string | null | undefined, field: string): string | null | undefined {
    if (value === undefined) return undefined;
    const trimmed = value?.trim();
    if (!trimmed) return null;

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new BadRequestException(`${field} must be a full URL, starting with https://`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new BadRequestException(`${field} must be an http or https link`);
    }
    return parsed.toString();
  }

  async update(input: SiteSettingsInput, updatedBy: string) {
    const data: Record<string, unknown> = { updatedBy };

    if (input.companyName !== undefined) {
      const name = input.companyName.trim();
      if (name.length < 2) throw new BadRequestException('Company name is too short');
      data.companyName = name;
    }
    if (input.supportEmail !== undefined) {
      const email = input.supportEmail.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        throw new BadRequestException('Support email is not an email address');
      }
      data.supportEmail = email;
    }

    for (const field of [
      'phone',
      'address',
      'iosVersion',
      'androidVersion',
      'emailLegalName',
      'emailAddressLine',
      'emailOptInNote',
      'emailUnsubscribeNote',
    ] as const) {
      if (input[field] !== undefined) data[field] = input[field]?.trim() || null;
    }
    for (const field of URL_FIELDS) {
      const cleaned = this.cleanUrl(input[field], field);
      if (cleaned !== undefined) data[field] = cleaned;
    }

    /*
     * The unsubscribe target takes mailto: as well as http(s).
     * Until there is a preference centre, an address that reaches a person is
     * a better answer than a link to a page that does not exist yet.
     */
    if (input.emailUnsubscribeUrl !== undefined) {
      const value = input.emailUnsubscribeUrl?.trim();
      if (!value) {
        data.emailUnsubscribeUrl = null;
      } else if (/^mailto:[^@\s]+@[^@\s]+\.[^@\s]+/i.test(value)) {
        data.emailUnsubscribeUrl = value;
      } else {
        data.emailUnsubscribeUrl = this.cleanUrl(value, 'Unsubscribe link') ?? null;
      }
    }

    if (input.maintenanceMode !== undefined) data.maintenanceMode = input.maintenanceMode;
    if (input.maintenanceMessage !== undefined) {
      data.maintenanceMessage = input.maintenanceMessage?.trim() || null;
    }

    // Turning the site off with nothing to say leaves visitors staring at a
    // blank holding page wondering whether it is them.
    const next = { ...(await this.row()), ...data };
    if (next.maintenanceMode && !next.maintenanceMessage) {
      throw new BadRequestException(
        'Write a maintenance message before switching maintenance mode on',
      );
    }

    await this.prisma.siteSetting.upsert({
      where: { id: SINGLETON },
      create: { id: SINGLETON, ...data },
      update: data,
    });

    this.log.warn(`Site settings updated by ${updatedBy}: ${Object.keys(data).join(', ')}`);
    return this.get();
  }

  async setLogo(dataUrl: string, updatedBy: string) {
    const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(dataUrl.trim());
    if (!match) throw new BadRequestException('That does not look like an image');

    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length === 0) throw new BadRequestException('The image is empty');
    if (bytes.length > MAX_LOGO_BYTES) {
      throw new BadRequestException(
        `That logo is ${Math.round(bytes.length / 1024)} KB. The limit is ${
          MAX_LOGO_BYTES / 1024
        } KB.`,
      );
    }

    const signature = SIGNATURES.find((s) => s.test(bytes));
    if (!signature) {
      throw new BadRequestException('Only PNG, JPEG, WebP and SVG logos are accepted');
    }

    await this.prisma.siteSetting.upsert({
      where: { id: SINGLETON },
      create: {
        id: SINGLETON,
        logo: bytes,
        logoType: signature.type,
        logoUpdatedAt: new Date(),
        updatedBy,
      },
      update: {
        logo: bytes,
        logoType: signature.type,
        logoUpdatedAt: new Date(),
        updatedBy,
      },
    });
    return this.get();
  }

  async clearLogo(updatedBy: string) {
    await this.prisma.siteSetting.update({
      where: { id: SINGLETON },
      data: { logo: null, logoType: null, logoUpdatedAt: null, updatedBy },
    });
    return this.get();
  }

  async logo(): Promise<{ bytes: Buffer; type: string; version: string }> {
    const s = await this.prisma.siteSetting.findUnique({
      where: { id: SINGLETON },
      select: { logo: true, logoType: true, logoUpdatedAt: true },
    });
    if (!s?.logo || !s.logoType) throw new NotFoundException('No logo set');
    return {
      bytes: Buffer.from(s.logo),
      type: s.logoType,
      version: String(s.logoUpdatedAt?.getTime() ?? 0),
    };
  }
}
