/**
 * See every DavoChain email, and optionally send them for real.
 *
 *   npm run email:preview                                   write all emails as files to look at
 *   npm run email:preview -- --only user.email_verify       just one (or several, comma-separated)
 *   npm run email:preview -- --send you@gmail.com           also send them through the SMTP in .env
 *   npm run email:preview -- --send a@x.com,b@y.com --only trade.buy.completed
 *
 * Every email is filled with the sample values from the catalogue (SAMPLE_VALUES)
 * and rendered exactly as the API renders it: the same frame, logo and footer.
 * Files go to api/.superpowers/email-preview/ (not committed); open index.html
 * there to see them all side by side.
 *
 * Sending: only to the addresses typed after --send, with "[Test]" in front of
 * each subject. It never reads customers from the database. Refuses to send
 * when NODE_ENV=production.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { validateEnv } from '../src/config/env.validation';
import { PrismaService } from '../src/prisma/prisma.service';
import { CredentialsService } from '../src/common/credentials.service';
import { MailService } from '../src/common/mail.service';
import { SocialLinksService } from '../src/cms/social-links.service';
import { EmailTemplateService } from '../src/cms/email-template.service';
import { EMAIL_TEMPLATES, SAMPLE_VALUES } from '../src/cms/email-templates';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : undefined;
};
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function main() {
  const sendTo = (arg('send') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const only = (arg('only') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const bad = sendTo.filter((a) => !EMAIL.test(a));
  if (bad.length) throw new Error(`Not an email address: ${bad.join(', ')}`);
  if (sendTo.length && process.env.NODE_ENV === 'production') throw new Error('Refusing to send test emails in production.');

  const unknown = only.filter((k) => !EMAIL_TEMPLATES.some((t) => t.key === k));
  if (unknown.length) throw new Error(`No such email: ${unknown.join(', ')}. Run without --only to see them all.`);
  const templates = only.length ? EMAIL_TEMPLATES.filter((t) => only.includes(t.key)) : EMAIL_TEMPLATES;

  const config = new ConfigService(validateEnv(process.env));
  const prisma = new PrismaService();
  const credentials = new CredentialsService(prisma, config);
  credentials.onModuleInit();
  const mail = new MailService(prisma, config, credentials);
  const emails = new EmailTemplateService(prisma, config, mail, new SocialLinksService(prisma, config));

  if (sendTo.length && !mail.isConfigured) throw new Error('SMTP_HOST is not set in api/.env, so nothing can be sent.');

  const out = join(__dirname, '..', '.superpowers', 'email-preview');
  mkdirSync(out, { recursive: true });
  const index: string[] = [];
  let sent = 0;
  let failed = 0;

  try {
    for (const t of templates) {
      const r = await emails.render(t.key, { ...SAMPLE_VALUES, ...t.samples }, { ignoreActive: true });
      if (!r) continue;

      // For the browser, the logo carried inside the email becomes a data URL.
      let html = r.html;
      for (const a of r.attachments) html = html.split(`cid:${a.cid}`).join(`data:${a.contentType};base64,${a.content.toString('base64')}`);
      writeFileSync(join(out, `${t.key}.html`), html);
      writeFileSync(join(out, `${t.key}.txt`), `Subject: ${r.subject}\n\n${r.text}\n`);
      index.push(
        `<section><h2>${t.label} <small>${t.key}</small></h2><p><b>Subject:</b> ${r.subject.replace(/</g, '&lt;')}</p>` +
          `<iframe src="${t.key}.html" loading="lazy" title="${t.key}"></iframe></section>`,
      );

      for (const to of sendTo) {
        const ok = await mail.send({ to, subject: `[Test] ${r.subject}`, text: r.text, html: r.html, attachments: r.attachments, templateKey: t.key });
        console.log(`  ${ok ? 'sent  ' : 'FAILED'}  ${t.key.padEnd(30)} → ${to}`);
        if (ok) sent++;
        else failed++;
        // Gmail dislikes bursts; a short pause keeps a full run under its limits.
        await new Promise((res) => setTimeout(res, 1200));
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  writeFileSync(
    join(out, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>DavoChain emails</title>
<style>body{font-family:system-ui,sans-serif;background:#f6f7f9;margin:0;padding:24px}h1{margin:0 0 4px}section{background:#fff;border:1px solid #e3e7ec;border-radius:12px;padding:16px;margin:16px 0}h2{font-size:17px;margin:0 0 4px}small{color:#6b7280;font-weight:400}iframe{width:100%;height:900px;border:1px solid #e3e7ec;border-radius:8px}</style>
<h1>DavoChain emails</h1><p>${templates.length} emails, filled with sample values.</p>${index.join('\n')}`,
  );

  console.log(`\n  ${templates.length} email(s) written to ${out}`);
  console.log(`  Open ${join(out, 'index.html')} to see them all.`);
  if (sendTo.length) console.log(`  Sent ${sent}, failed ${failed}. Failures are listed above; the reason is in the email_logs table.`);
  if (failed) process.exitCode = 1;
}

main().catch((err: Error) => {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
});
