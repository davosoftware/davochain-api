import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { renderMarkdown } from './markdown';
import { excerptFromHtml, htmlToText, sanitiseHtml } from './sanitise';

/** Lowercase, hyphenated, no leading or trailing hyphen. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The pages the apps link to by slug.
 *
 * Placeholders, deliberately marked as such. Empty pages would look finished
 * and ship as blank screens; text that says it needs replacing gets replaced.
 * The legal wording is not ours to write — it needs a lawyer, and pretending
 * otherwise by shipping plausible-sounding terms would be worse than a page
 * that admits it is a draft.
 */
const SYSTEM_PAGES = ([
  {
    slug: 'about-us',
    title: 'About us',
    sortOrder: 1,
    excerpt: 'Who we are and what we do.',
    body: `## About us

> **This page has not been written yet.** Replace it from the dashboard:
> **CMS → Static content → About us**.

Davochain is a Nigerian crypto exchange. Buy, sell and swap coins with naira,
at a rate you see before you commit.`,
  },
  {
    slug: 'terms-and-conditions',
    title: 'Terms and conditions',
    sortOrder: 2,
    excerpt: 'The agreement between you and us.',
    body: `## Terms and conditions

> **Placeholder.** These terms have not been drafted. They need a lawyer, not a
> template — replace this from **CMS → Static content** before launch.

By using Davochain you agree to the terms set out on this page.`,
  },
  {
    slug: 'privacy-policy',
    title: 'Privacy policy',
    sortOrder: 3,
    excerpt: 'What we collect, and what we do with it.',
    body: `## Privacy policy

> **Placeholder.** This policy has not been drafted. Nigeria's NDPR has specific
> requirements — replace this from **CMS → Static content** before launch.

We collect what we need to run your account and verify your identity, and no
more.`,
  },
] as { slug: string; title: string; sortOrder: number; excerpt: string; body: string }[]).map(
  (page) => ({ ...page, body: renderMarkdown(page.body) }),
);

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .slice(0, 80)
    .replace(/^-|-$/g, '');
}

/**
 * Static pages and FAQs.
 *
 * Both are stored as Markdown and rendered on the way out, so the website, the
 * app and any future surface get the same words without one of them owning the
 * formatting. Public reads never see a draft.
 */
@Injectable()
export class CmsService implements OnModuleInit {
  private readonly log = new Logger(CmsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The apps link to these three by slug, so they have to exist.
   *
   * Created on boot rather than in the seed script because a missing Terms page
   * is a 404 on a legal screen in a shipped build — a failure mode that must
   * not depend on somebody having remembered to run a seed. Idempotent: an
   * existing page is never overwritten, so an admin's wording survives every
   * deploy.
   */
  async onModuleInit(): Promise<void> {
    for (const page of SYSTEM_PAGES) {
      await this.prisma.staticPage
        .upsert({
          where: { slug: page.slug },
          create: { ...page, isSystem: true },
          // Nothing. The page exists; whatever it says now is what an admin
          // meant it to say.
          update: {},
        })
        .catch((err: Error) => this.log.error(`Could not seed "${page.slug}": ${err.message}`));
    }
  }

  // ── pages, public ─────────────────────────────────────────

  /** Index for a footer or an app's legal menu. No bodies — those are per page. */
  async publicPages() {
    const rows = await this.prisma.staticPage.findMany({
      where: { isPublished: true },
      orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
      select: { slug: true, title: true, excerpt: true, body: true, updatedAt: true },
    });

    return rows.map((p) => ({
      slug: p.slug,
      title: p.title,
      // Falls back to the first line or so of the body, so a page nobody wrote
      // a summary for still has something a card can print.
      excerpt: p.excerpt ?? excerptFromHtml(p.body),
      updatedAt: p.updatedAt,
    }));
  }

  /**
   * One page, in three forms.
   *
   * `html` for the website, `text` for anything that cannot render markup, and
   * `markdown` for a client that would rather do its own styling — a Flutter
   * screen looks better with native widgets than with a WebView.
   */
  async publicPage(slug: string) {
    const page = await this.prisma.staticPage.findUnique({ where: { slug: slug.toLowerCase() } });
    if (!page || !page.isPublished) throw new NotFoundException('Page not found');

    return {
      slug: page.slug,
      title: page.title,
      excerpt: page.excerpt ?? excerptFromHtml(page.body),
      html: page.body,
      text: htmlToText(page.body),
      updatedAt: page.updatedAt,
    };
  }

  // ── pages, admin ──────────────────────────────────────────

  async listPages() {
    const rows = await this.prisma.staticPage.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      excerpt: p.excerpt,
      body: p.body,
      isPublished: p.isPublished,
      isSystem: p.isSystem,
      sortOrder: p.sortOrder,
      updatedAt: p.updatedAt,
      updatedBy: p.updatedBy,
    }));
  }

  async createPage(
    adminId: string,
    input: { title: string; slug?: string; body: string; excerpt?: string; isPublished?: boolean },
  ) {
    const title = input.title?.trim();
    if (!title) throw new BadRequestException('A title is required');

    const slug = (input.slug?.trim() || slugify(title)).toLowerCase();
    if (!SLUG.test(slug)) {
      throw new BadRequestException(
        'A slug is lowercase letters, numbers and hyphens — for example "terms-and-conditions"',
      );
    }

    const clash = await this.prisma.staticPage.findUnique({ where: { slug } });
    if (clash) throw new ConflictException(`There is already a page at "${slug}"`);

    const last = await this.prisma.staticPage.findFirst({ orderBy: { sortOrder: 'desc' } });

    return this.prisma.staticPage.create({
      data: {
        slug,
        title,
        // Cleaned here, so nothing unsafe is ever stored and a value read back
        // out is already safe to render.
        body: sanitiseHtml(input.body ?? ''),
        excerpt: input.excerpt?.trim() || null,
        isPublished: input.isPublished ?? true,
        sortOrder: (last?.sortOrder ?? 0) + 1,
        updatedBy: adminId,
      },
    });
  }

  async updatePage(
    adminId: string,
    id: string,
    input: {
      title?: string;
      slug?: string;
      body?: string;
      excerpt?: string | null;
      isPublished?: boolean;
      sortOrder?: number;
    },
  ) {
    const page = await this.prisma.staticPage.findUnique({ where: { id } });
    if (!page) throw new NotFoundException('Page not found');

    let slug = page.slug;
    if (input.slug !== undefined && input.slug.trim().toLowerCase() !== page.slug) {
      if (page.isSystem) {
        // The app looks this page up by slug. Renaming it is a 404 on a legal
        // screen in a shipped build, which no admin can undo from here.
        throw new BadRequestException(
          `"${page.title}" is linked from the apps by its address, so the address cannot change. The title and the wording can.`,
        );
      }
      slug = input.slug.trim().toLowerCase();
      if (!SLUG.test(slug)) {
        throw new BadRequestException('A slug is lowercase letters, numbers and hyphens');
      }
      const clash = await this.prisma.staticPage.findUnique({ where: { slug } });
      if (clash && clash.id !== id) throw new ConflictException(`There is already a page at "${slug}"`);
    }

    if (input.isPublished === false && page.isSystem) {
      throw new BadRequestException(
        `"${page.title}" is shown in the apps and cannot be unpublished. Edit the wording instead.`,
      );
    }

    return this.prisma.staticPage.update({
      where: { id },
      data: {
        slug,
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.body !== undefined ? { body: sanitiseHtml(input.body) } : {}),
        ...(input.excerpt !== undefined ? { excerpt: input.excerpt?.trim() || null } : {}),
        ...(input.isPublished !== undefined ? { isPublished: input.isPublished } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        updatedBy: adminId,
      },
    });
  }

  async deletePage(id: string) {
    const page = await this.prisma.staticPage.findUnique({ where: { id } });
    if (!page) throw new NotFoundException('Page not found');
    if (page.isSystem) {
      throw new BadRequestException(
        `"${page.title}" is shown in the apps and cannot be deleted. Clear the wording if you need it blank.`,
      );
    }
    await this.prisma.staticPage.delete({ where: { id } });
    return { deleted: true };
  }

  // ── FAQs ──────────────────────────────────────────────────

  /**
   * Grouped by category, in the order an admin set.
   *
   * The website renders these as an accordion, so the grouping is done here
   * rather than being re-derived by every client that wants headings.
   */
  async publicFaqs() {
    const rows = await this.prisma.faq.findMany({
      where: { isPublished: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    const groups = new Map<string, { category: string; items: unknown[] }>();
    for (const f of rows) {
      const category = f.category?.trim() || 'General';
      if (!groups.has(category)) groups.set(category, { category, items: [] });
      groups.get(category)!.items.push({
        id: f.id,
        question: f.question,
        answerHtml: f.answer,
        answerText: htmlToText(f.answer),
      });
    }

    return { total: rows.length, groups: [...groups.values()] };
  }

  async listFaqs() {
    const rows = await this.prisma.faq.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((f) => ({
      id: f.id,
      question: f.question,
      answer: f.answer,
      category: f.category,
      isPublished: f.isPublished,
      sortOrder: f.sortOrder,
      updatedAt: f.updatedAt,
      updatedBy: f.updatedBy,
    }));
  }

  async createFaq(
    adminId: string,
    input: { question: string; answer: string; category?: string; isPublished?: boolean },
  ) {
    const question = input.question?.trim();
    const answer = input.answer?.trim();
    if (!question) throw new BadRequestException('A question is required');
    if (!answer) throw new BadRequestException('An answer is required');

    const last = await this.prisma.faq.findFirst({ orderBy: { sortOrder: 'desc' } });

    return this.prisma.faq.create({
      data: {
        question,
        answer: sanitiseHtml(answer),
        category: input.category?.trim() || null,
        isPublished: input.isPublished ?? true,
        sortOrder: (last?.sortOrder ?? 0) + 1,
        updatedBy: adminId,
      },
    });
  }

  async updateFaq(
    adminId: string,
    id: string,
    input: {
      question?: string;
      answer?: string;
      category?: string | null;
      isPublished?: boolean;
      sortOrder?: number;
    },
  ) {
    const existing = await this.prisma.faq.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('FAQ not found');

    return this.prisma.faq.update({
      where: { id },
      data: {
        ...(input.question !== undefined ? { question: input.question.trim() } : {}),
        ...(input.answer !== undefined ? { answer: sanitiseHtml(input.answer.trim()) } : {}),
        ...(input.category !== undefined ? { category: input.category?.trim() || null } : {}),
        ...(input.isPublished !== undefined ? { isPublished: input.isPublished } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        updatedBy: adminId,
      },
    });
  }

  async deleteFaq(id: string) {
    const existing = await this.prisma.faq.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('FAQ not found');
    await this.prisma.faq.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * Apply a whole new order in one call.
   *
   * Drag-and-drop produces one final arrangement, not a sequence of swaps, and
   * sending it as one transaction means a dropped request cannot leave the list
   * half-reordered.
   */
  async reorderFaqs(adminId: string, ids: string[]) {
    await this.prisma.$transaction(
      ids.map((id, index) =>
        this.prisma.faq.update({
          where: { id },
          data: { sortOrder: index, updatedBy: adminId },
        }),
      ),
    );
    return this.listFaqs();
  }
}
