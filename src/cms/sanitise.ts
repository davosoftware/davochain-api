import sanitizeHtml from 'sanitize-html';

/**
 * The gate between the rich-text editor and everything that renders its output.
 *
 * Admin content reaches three places that will happily execute what they are
 * given: the public website, the apps, and an email client. The editor produces
 * HTML, so an allowlist is the only thing standing between a pasted `<script>`
 * and a script running on the marketing site.
 *
 * `sanitize-html` does the parsing. Hand-rolling this was the alternative and it
 * is a bad one — a sanitiser has to be right about every tag, attribute,
 * protocol and encoding trick, and being wrong once is the whole hole.
 *
 * Applied **on write**, so nothing unsafe is ever stored. A value read back out
 * of the database has already been through here.
 */

/**
 * What the toolbar can produce, and nothing else.
 *
 * Notably absent: `script`, `style`, `iframe`, `object`, `embed`, `form` and
 * `input`. A `style` element would let one page restyle the whole site; a form
 * would let an email or a Terms page ask for a password.
 */
const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'span', 'div',
  'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'sub', 'sup', 'mark',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'blockquote', 'pre', 'code',
  'a', 'img',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
];

/**
 * Inline styles are allowed but individually — this is what makes fonts and
 * colours work while keeping `position`, `behavior` and `expression` out.
 */
const ALLOWED_STYLES: Record<string, RegExp[]> = {
  color: [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s.,%]+\)$/i, /^[a-z]+$/i],
  'background-color': [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s.,%]+\)$/i, /^[a-z]+$/i],
  'font-family': [/^[\w\s,'"-]+$/],
  'font-size': [/^\d+(\.\d+)?(px|pt|em|rem|%)$/],
  'font-weight': [/^(normal|bold|lighter|bolder|[1-9]00)$/],
  'font-style': [/^(normal|italic|oblique)$/],
  'text-align': [/^(left|right|center|justify)$/],
  'text-decoration': [/^[\w\s-]+$/],
  'line-height': [/^\d+(\.\d+)?(px|pt|em|rem|%)?$/],
  'letter-spacing': [/^-?\d+(\.\d+)?(px|pt|em|rem)$/],
  'padding': [/^[\d\s.]+(px|pt|em|rem|%)?[\d\s.a-z%]*$/],
  'padding-left': [/^\d+(\.\d+)?(px|pt|em|rem|%)$/],
  'margin': [/^[\d\s.auto]+[\d\s.a-z%]*$/],
  'margin-left': [/^\d+(\.\d+)?(px|pt|em|rem|%)$/],
  'border': [/^[\w\s#(),.%-]+$/],
  'border-radius': [/^[\d\s.]+(px|pt|em|rem|%)?$/],
  'border-collapse': [/^(collapse|separate)$/],
  width: [/^\d+(\.\d+)?(px|pt|em|rem|%)$/],
  'max-width': [/^\d+(\.\d+)?(px|pt|em|rem|%)$/],
  height: [/^(auto|\d+(\.\d+)?(px|pt|em|rem|%))$/],
  'vertical-align': [/^(top|middle|bottom|baseline)$/],
};

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel', 'style'],
    img: ['src', 'alt', 'title', 'width', 'height', 'style'],
    td: ['colspan', 'rowspan', 'style', 'align', 'valign'],
    th: ['colspan', 'rowspan', 'style', 'align', 'valign', 'scope'],
    table: ['style', 'border', 'cellpadding', 'cellspacing', 'width', 'align'],
    col: ['style', 'width', 'span'],
    '*': ['style', 'dir'],
  },
  allowedStyles: { '*': ALLOWED_STYLES },

  /*
   * Schemes that cannot execute.
   *
   * `data:` is deliberately absent even for images: a data URL can carry an
   * HTML document, and a pasted screenshot as base64 makes an email several
   * megabytes that most clients then refuse to show. Images belong in the
   * upload, which produces a real URL.
   */
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,

  // Anything not on the list loses its tag but keeps its words, so removing a
  // stray <font> does not silently delete a paragraph of somebody's writing.
  // The exceptions are elements whose *content* is not prose.
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe'],

  transformTags: {
    // Every outbound link opens away from the page it was on, and cannot reach
    // back through window.opener.
    a: (tagName, attribs) => ({
      tagName,
      attribs: {
        ...attribs,
        ...(attribs.href ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
      },
    }),
  },
};

/** Clean a rich-text body. Safe to store, and safe to render as-is. */
export function sanitiseHtml(dirty: string): string {
  return sanitizeHtml(dirty ?? '', OPTIONS);
}

/**
 * A readable plain-text version of the same content.
 *
 * Every email carries both parts: some clients refuse HTML, some people turn it
 * off, and a spam filter is more suspicious of an HTML-only message than of one
 * with a sensible text alternative.
 */
export function htmlToText(html: string): string {
  const withBreaks = (html ?? '')
    // Block boundaries become newlines before the tags are stripped, or the
    // whole email arrives as one run-on paragraph.
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<hr\s*\/?>/gi, '\n—\n')
    // Keep a link's destination: "terms (https://…)" reads correctly aloud and
    // is the only way the address survives at all in a text part.
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gis, '$2 ($1)');

  return sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {} })
    // sanitize-html leaves entities encoded; a text part wants the characters.
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** For a list card or a meta description, where markup would be noise. */
export function excerptFromHtml(html: string, maxLength = 180): string {
  const text = htmlToText(html).replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 60 ? lastSpace : maxLength)}…`;
}
