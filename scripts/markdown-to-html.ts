#!/usr/bin/env ts-node
/**
 * One-off: convert CMS bodies written in Markdown into HTML.
 *
 *   npm run cms:to-html -- --dry   # show what would change
 *   npm run cms:to-html            # apply it
 *
 * The CMS used to store Markdown and render it on the way out. It now stores
 * the HTML the rich-text editor produces, which is what the website, the apps
 * and every email receive directly. Rows written before that change are still
 * Markdown, and would otherwise be shown to users as literal `##` and `**`.
 *
 * Safe to run more than once: a body that already contains block-level HTML is
 * left alone.
 */
import { PrismaClient } from '@prisma/client';
import { renderMarkdown } from '../src/cms/markdown';

const dry = process.argv.includes('--dry');
const prisma = new PrismaClient();

/** Already converted? Anything with a block tag came from the editor. */
const isHtml = (body?: string | null): boolean =>
  /<(p|h[1-6]|ul|ol|div|blockquote|table|pre)\b/i.test(body ?? '');

async function convert(
  label: string,
  rows: { id: string; source: string | null }[],
  save: (id: string, html: string) => Promise<unknown>,
): Promise<void> {
  let changed = 0;
  for (const row of rows) {
    if (!row.source || isHtml(row.source)) continue;
    changed++;
    if (!dry) await save(row.id, renderMarkdown(row.source));
  }
  console.log(`${label}: ${changed} of ${rows.length} ${dry ? 'would be ' : ''}converted`);
}

async function main(): Promise<void> {
  await convert(
    'static pages',
    (await prisma.staticPage.findMany({ select: { id: true, body: true } })).map((p) => ({
      id: p.id,
      source: p.body,
    })),
    (id, body) => prisma.staticPage.update({ where: { id }, data: { body } }),
  );

  await convert(
    'FAQs',
    (await prisma.faq.findMany({ select: { id: true, answer: true } })).map((f) => ({
      id: f.id,
      source: f.answer,
    })),
    (id, answer) => prisma.faq.update({ where: { id }, data: { answer } }),
  );

  await convert(
    'email templates',
    (await prisma.emailTemplate.findMany({ select: { key: true, body: true } })).map((t) => ({
      id: t.key,
      source: t.body,
    })),
    (key, body) => prisma.emailTemplate.update({ where: { key }, data: { body } }),
  );

  if (dry) console.log('\nDry run — nothing was written. Drop --dry to apply.');
}

main()
  .catch((err: Error) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
