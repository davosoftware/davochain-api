/**
 * A deliberately small Markdown renderer.
 *
 * Why not store HTML and sanitise it: a sanitiser has to be right about every
 * tag, attribute, protocol and encoding trick an attacker can reach for, and
 * being wrong once is a script running on the marketing site. This goes the
 * other way round — **the source is escaped before any formatting is applied**,
 * so the only tags that can appear in the output are ones this file wrote. An
 * admin who pastes `<script>` into Terms and Conditions gets the literal text
 * `<script>` on the page, which is the correct and boring outcome.
 *
 * That property is worth more than feature coverage, so the feature set is
 * small on purpose: headings, bold, italic, links, lists, quotes, rules, inline
 * code and paragraphs. It is enough for a privacy policy and an email.
 */

/** Everything that could start a tag or an entity, neutralised first. */
function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Only schemes that cannot execute.
 *
 * `javascript:` is the obvious one, but `data:` is just as bad — a data URL can
 * carry an HTML document — and so is `vbscript:`. Anything not on the list
 * becomes a plain `#`, so a malicious link is inert rather than absent, and the
 * text around it still reads correctly.
 */
function safeUrl(raw: string): string {
  const url = raw.trim();
  if (/^(https?:\/\/|mailto:|tel:|\/)/i.test(url)) return escapeHtml(url);
  return '#';
}

/**
 * Inline formatting. Runs on text that is ALREADY escaped.
 *
 * Code spans are separated out first and never formatted. Replacing them in
 * place would not be enough — the text between the backticks stays in the
 * string, so the emphasis pass that follows still finds the asterisks in
 * `a *b* c` and italicises them inside what is meant to be literal.
 */
function inline(escaped: string): string {
  // Split on code spans and format only what is between them. No sentinel, so
  // there is nothing an author could type that collides with one.
  return escaped
    .split(/(`[^`]+`)/g)
    .map((part) =>
      part.startsWith('`') && part.endsWith('`') && part.length > 1
        ? `<code>${part.slice(1, -1)}</code>`
        : format(part),
    )
    .join('');
}

/** Links and emphasis, for a stretch of text known to contain no code span. */
function format(text: string): string {
  return (
    text
      // [label](url)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
        // Links in an email open outside our control either way; rel and target
        // are for the website, where they matter.
        return `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      // Single asterisk, but not one that belongs to a ** pair.
      .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>')
  );
}

/**
 * Markdown to HTML.
 *
 * Block-level parsing is a single pass over the lines, which is all this
 * grammar needs — there is no nesting to track beyond a list being open or not.
 */
export function renderMarkdown(source: string): string {
  const lines = escapeHtml(source ?? '').split(/\r?\n/);
  const out: string[] = [];

  let listType: 'ul' | 'ol' | null = null;
  let paragraph: string[] = [];
  let quote: string[] = [];

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  const closeParagraph = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${inline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };

  // A quote that wraps over several lines is one quote. Emitting a blockquote
  // per line boxes each line separately, which looks like a mistake because it
  // is one.
  const closeQuote = () => {
    if (quote.length > 0) {
      out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`);
      quote = [];
    }
  };

  const flush = () => {
    closeParagraph();
    closeQuote();
    closeList();
  };

  for (const line of lines) {
    const text = line.trimEnd();

    if (text.trim() === '') {
      flush();
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(text);
    if (heading) {
      flush();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
      continue;
    }

    if (/^(---|\*\*\*|___)\s*$/.test(text)) {
      flush();
      out.push('<hr />');
      continue;
    }

    const quoted = /^&gt;\s?(.*)$/.exec(text); // ">" is already escaped by now
    if (quoted) {
      closeParagraph();
      closeList();
      quote.push(quoted[1]);
      continue;
    }
    // Any other line ends the quote it was following.
    closeQuote();

    const bullet = /^[-*+]\s+(.*)$/.exec(text);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(text);
    if (bullet || numbered) {
      closeParagraph();
      const wanted: 'ul' | 'ol' = bullet ? 'ul' : 'ol';
      if (listType !== wanted) {
        closeList();
        out.push(`<${wanted}>`);
        listType = wanted;
      }
      out.push(`<li>${inline((bullet ?? numbered)![1])}</li>`);
      continue;
    }

    // Anything else joins the paragraph being built. A single newline inside a
    // paragraph is a space, as it is everywhere else in Markdown.
    closeList();
    paragraph.push(text.trim());
  }

  flush();
  return out.join('\n');
}

/**
 * A readable plain-text version of the same source.
 *
 * Every email carries both parts: some clients refuse HTML, some people turn it
 * off, and a spam filter is more suspicious of an HTML-only message than of one
 * with a sensible text alternative.
 */
export function markdownToText(source: string): string {
  return (source ?? '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1$2')
    .replace(/^#{1,4}\s+/gm, '')
    .replace(/^&gt;\s?/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^(---|\*\*\*|___)\s*$/gm, '—')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** For a list card or a meta description, where markup would be noise. */
export function excerptFrom(source: string, maxLength = 180): string {
  const text = markdownToText(source).replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 60 ? lastSpace : maxLength)}…`;
}

/**
 * `{{name}}` substitution.
 *
 * A placeholder with no value is left standing rather than blanked, because
 * "Hi ," in a live email is a bug that reads as one, while a visible
 * `{{firstName}}` says exactly what went wrong and where.
 *
 * Values are inserted BEFORE the Markdown is rendered, and the renderer escapes
 * everything, so a user whose name contains a bracket cannot inject anything.
 */
export function fillVariables(
  source: string,
  values: Record<string, string | null | undefined>,
): string {
  return (source ?? '').replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (whole, name: string) => {
    const value = values[name];
    return value === undefined || value === null || value === '' ? whole : String(value);
  });
}

/** Which placeholders a body actually uses — for the editor, and for warnings. */
export function variablesUsed(source: string): string[] {
  const found = new Set<string>();
  for (const m of (source ?? '').matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)) found.add(m[1]);
  return [...found];
}
