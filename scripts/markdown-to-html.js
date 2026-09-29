#!/usr/bin/env ts-node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const markdown_1 = require("../src/cms/markdown");
const dry = process.argv.includes('--dry');
const prisma = new client_1.PrismaClient();
const isHtml = (body) => /<(p|h[1-6]|ul|ol|div|blockquote|table|pre)\b/i.test(body ?? '');
async function convert(label, rows, save) {
    let changed = 0;
    for (const row of rows) {
        if (!row.source || isHtml(row.source))
            continue;
        changed++;
        if (!dry)
            await save(row.id, (0, markdown_1.renderMarkdown)(row.source));
    }
    console.log(`${label}: ${changed} of ${rows.length} ${dry ? 'would be ' : ''}converted`);
}
async function main() {
    await convert('static pages', (await prisma.staticPage.findMany({ select: { id: true, body: true } })).map((p) => ({
        id: p.id,
        source: p.body,
    })), (id, body) => prisma.staticPage.update({ where: { id }, data: { body } }));
    await convert('FAQs', (await prisma.faq.findMany({ select: { id: true, answer: true } })).map((f) => ({
        id: f.id,
        source: f.answer,
    })), (id, answer) => prisma.faq.update({ where: { id }, data: { answer } }));
    await convert('email templates', (await prisma.emailTemplate.findMany({ select: { key: true, body: true } })).map((t) => ({
        id: t.key,
        source: t.body,
    })), (key, body) => prisma.emailTemplate.update({ where: { key }, data: { body } }));
    if (dry)
        console.log('\nDry run — nothing was written. Drop --dry to apply.');
}
main()
    .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
})
    .finally(() => prisma.$disconnect());
//# sourceMappingURL=markdown-to-html.js.map