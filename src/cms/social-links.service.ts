import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

/** 256 KB. A 128px icon is a few KB; this only stops somebody uploading a poster. */
const MAX_ICON_BYTES = 256 * 1024;

/**
 * The recommended source size, in pixels.
 *
 * Icons are drawn at 32pt in the email, and a retina display renders that at
 * 64. 128 is the next step up, which keeps them crisp on a 3× screen and still
 * measures in single-digit kilobytes.
 */
export const ICON_PIXELS = 128;

/**
 * The networks worth offering by name.
 *
 * A starting list, not a constraint — the label is free text, so a network
 * nobody thought of needs no migration and no deploy. The fallback glyph is
 * what the email draws when no icon has been uploaded, so a row is never a hole
 * in the footer.
 */
export const KNOWN_NETWORKS: { label: string; glyph: string; placeholder: string }[] = [
  { label: 'Facebook', glyph: 'f', placeholder: 'https://facebook.com/davochain' },
  { label: 'Instagram', glyph: 'ig', placeholder: 'https://instagram.com/davochain' },
  { label: 'X', glyph: '&#120143;', placeholder: 'https://x.com/davochain' },
  { label: 'LinkedIn', glyph: 'in', placeholder: 'https://linkedin.com/company/davochain' },
  { label: 'YouTube', glyph: '&#9658;', placeholder: 'https://youtube.com/@davochain' },
  { label: 'TikTok', glyph: '&#9834;', placeholder: 'https://tiktok.com/@davochain' },
  { label: 'WhatsApp', glyph: 'wa', placeholder: 'https://wa.me/2349160012046' },
  { label: 'Telegram', glyph: 'tg', placeholder: 'https://t.me/davochain' },
];

/** The glyph for a label, or its first letter for one we do not know. */
export function glyphFor(label: string): string {
  const known = KNOWN_NETWORKS.find((n) => n.label.toLowerCase() === label.trim().toLowerCase());
  if (known) return known.glyph;
  // Two letters of whatever they called it — enough to tell one row from
  // another, and never an empty circle.
  return label.trim().slice(0, 2).toLowerCase() || '&middot;';
}

/**
 * The social networks shown in every email footer and on the website.
 *
 * A table rather than a column per network. "Add TikTok" was previously a
 * schema change, a migration and a deploy; now it is a row, and the icon comes
 * with it.
 */
@Injectable()
export class SocialLinksService implements OnModuleInit {
  private readonly log = new Logger(SocialLinksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Carry over the links that used to live on the settings row.
   *
   * Runs once, only when there are no rows yet and the old columns hold
   * something. Without it, upgrading an install would silently empty the footer
   * of every email — the links would still be in the database, and nothing
   * would read them.
   */
  async onModuleInit(): Promise<void> {
    try {
      if ((await this.prisma.socialLink.count()) > 0) return;

      const s = await this.prisma.siteSetting.findUnique({ where: { id: 'default' } });
      if (!s) return;

      const legacy: [string, string | null][] = [
        ['Facebook', s.facebook],
        ['Instagram', s.instagram],
        ['X', s.twitter],
        ['LinkedIn', s.linkedin],
        ['YouTube', s.youtube],
        ['TikTok', s.tiktok],
      ];

      const rows = legacy
        .filter(([, url]) => Boolean(url?.trim()))
        .map(([label, url], index) => ({ label, url: url!.trim(), sortOrder: index }));

      if (rows.length === 0) return;
      // skipDuplicates, not the count check alone: a count can be read as zero
      // by two callers before either of them writes, and then both write.
      await this.prisma.socialLink.createMany({ data: rows, skipDuplicates: true });
      this.log.log(`Carried ${rows.length} social link(s) over from the settings row`);
    } catch (err) {
      this.log.error(`Could not carry social links over: ${(err as Error).message}`);
    }
  }

  private base(): string {
    return (this.config.get<string>('PUBLIC_API_URL') ?? 'http://localhost:3000').replace(/\/$/, '');
  }

  private iconUrl(row: { id: string; iconType: string | null; iconUpdatedAt: Date | null }) {
    return row.iconType
      ? `${this.base()}/v1/site/social/${row.id}/icon?v=${row.iconUpdatedAt?.getTime() ?? 0}`
      : null;
  }

  /** Everything, enabled or not. For the admin screen. */
  async list() {
    const rows = await this.prisma.socialLink.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      // Never the bytes: a list of eight icons is not a reason to read them.
      select: {
        id: true,
        label: true,
        url: true,
        isEnabled: true,
        sortOrder: true,
        iconType: true,
        iconUpdatedAt: true,
        updatedAt: true,
        updatedBy: true,
      },
    });

    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      url: r.url,
      isEnabled: r.isEnabled,
      sortOrder: r.sortOrder,
      iconUrl: this.iconUrl(r),
      /** What the email draws when there is no icon. */
      glyph: glyphFor(r.label),
      updatedAt: r.updatedAt,
      updatedBy: r.updatedBy,
    }));
  }

  /** Only the ones switched on. For an email and for the website. */
  async enabled() {
    const rows = await this.prisma.socialLink.findMany({
      where: { isEnabled: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, label: true, url: true, iconType: true, iconUpdatedAt: true },
    });

    return rows.map((r) => ({
      label: r.label,
      url: r.url,
      iconUrl: this.iconUrl(r),
      glyph: glyphFor(r.label),
    }));
  }

  /**
   * A URL a browser will follow, or nothing.
   *
   * Only http and https. This is echoed into every email we send and onto the
   * public website, so a `javascript:` link here would be a script somebody
   * else wrote running on both.
   */
  private cleanUrl(value: string): string {
    const trimmed = value?.trim();
    if (!trimmed) throw new BadRequestException('A link is required');

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new BadRequestException('That must be a full link, starting with https://');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new BadRequestException('A social link must be an http or https address');
    }
    return parsed.toString();
  }

  async create(adminId: string, input: { label: string; url: string; isEnabled?: boolean }) {
    const label = input.label?.trim();
    if (!label) throw new BadRequestException('A name is required');
    if (label.length > 40) throw new BadRequestException('That name is too long');

    const clash = await this.prisma.socialLink.findUnique({ where: { label } });
    if (clash) {
      throw new BadRequestException(
        `There is already a link called "${label}". Rename one of them — two rows with the same name show as two identical icons.`,
      );
    }

    const last = await this.prisma.socialLink.findFirst({ orderBy: { sortOrder: 'desc' } });

    const row = await this.prisma.socialLink.create({
      data: {
        label,
        url: this.cleanUrl(input.url),
        isEnabled: input.isEnabled ?? true,
        sortOrder: (last?.sortOrder ?? 0) + 1,
        updatedBy: adminId,
      },
    });
    return { ...row, iconUrl: this.iconUrl(row), glyph: glyphFor(row.label) };
  }

  async update(
    adminId: string,
    id: string,
    input: { label?: string; url?: string; isEnabled?: boolean; sortOrder?: number },
  ) {
    const existing = await this.prisma.socialLink.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('That link is not here');

    const row = await this.prisma.socialLink.update({
      where: { id },
      data: {
        ...(input.label !== undefined ? { label: input.label.trim() } : {}),
        ...(input.url !== undefined ? { url: this.cleanUrl(input.url) } : {}),
        ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        updatedBy: adminId,
      },
    });
    return { ...row, iconUrl: this.iconUrl(row), glyph: glyphFor(row.label) };
  }

  async remove(id: string) {
    const existing = await this.prisma.socialLink.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('That link is not here');
    await this.prisma.socialLink.delete({ where: { id } });
    return { deleted: true };
  }

  /** Apply a whole arrangement in one transaction, like the FAQ order. */
  async reorder(adminId: string, ids: string[]) {
    await this.prisma.$transaction(
      ids.map((id, index) =>
        this.prisma.socialLink.update({
          where: { id },
          data: { sortOrder: index, updatedBy: adminId },
        }),
      ),
    );
    return this.list();
  }

  /**
   * Store an icon.
   *
   * Checked by its first bytes rather than by the type it claims. SVG is
   * refused even though it would be the obvious format for an icon: Gmail,
   * Outlook and Apple Mail all decline to render it, so an SVG here is a hole
   * in the footer of every email.
   */
  async setIcon(id: string, dataUrl: string, adminId: string) {
    const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(dataUrl.trim());
    if (!match) throw new BadRequestException('That does not look like an image');

    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.byteLength === 0) throw new BadRequestException('That image is empty');
    if (bytes.byteLength > MAX_ICON_BYTES) {
      throw new BadRequestException(
        `That icon is ${Math.round(bytes.byteLength / 1024)} KB. The limit is ${MAX_ICON_BYTES / 1024} KB — an icon is a few kilobytes.`,
      );
    }

    const type = detectIconType(bytes);
    if (!type) {
      throw new BadRequestException('Use a PNG, JPEG or GIF. Mail clients do not render SVG.');
    }

    const row = await this.prisma.socialLink.update({
      where: { id },
      data: { icon: bytes, iconType: type, iconUpdatedAt: new Date(), updatedBy: adminId },
    });
    return { iconUrl: this.iconUrl(row) };
  }

  async clearIcon(id: string, adminId: string) {
    await this.prisma.socialLink.update({
      where: { id },
      data: { icon: null, iconType: null, iconUpdatedAt: null, updatedBy: adminId },
    });
    // The letterform takes over again, so the row is still shown.
    return { cleared: true };
  }

  /** The bytes, for the public route a mail client fetches. */
  async icon(id: string): Promise<{ bytes: Buffer; type: string; version: string }> {
    const row = await this.prisma.socialLink.findUnique({
      where: { id },
      select: { icon: true, iconType: true, iconUpdatedAt: true },
    });
    if (!row?.icon || !row.iconType) throw new NotFoundException('No icon set');
    return {
      bytes: Buffer.from(row.icon),
      type: row.iconType,
      version: String(row.iconUpdatedAt?.getTime() ?? 0),
    };
  }
}

/** What a file *is*, not what it claims to be. Only formats every client renders. */
function detectIconType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  return null;
}
