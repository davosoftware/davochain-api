/**
 * The frame every email is sent in.
 *
 * Written once, here, and not editable from the dashboard. An admin writes the
 * message; the logo, the header, the picture, the footer and the legal lines
 * are added around it. That split is the whole point — one correction to the
 * layout fixes every email at once, and twenty-two copies of a header is
 * twenty-two chances to be inconsistent.
 *
 * ## Why it looks like 2005 HTML
 *
 * Email clients are not browsers. Outlook renders with Microsoft Word, Gmail
 * strips `<style>` blocks when a message is forwarded, and flexbox and grid
 * collapse in most of them. Nested tables with inline styles is not nostalgia,
 * it is the only layout that survives everywhere.
 */

/**
 * Blue and white, taken from the dashboard's own brand token rather than picked
 * again by eye — `oklch(0.52 0.19 259)` converted to sRGB is `#1062d3`, and the
 * darker bands are the same hue at lower lightness. Email needs hex; oklch is
 * not supported anywhere that matters.
 */
export const BRAND = {
  /** The header and footer bands. */
  band: '#102c58',
  /** The panel the picture sits on, one step deeper than the band. */
  bandDeep: '#0b2142',
  /** The dashboard's primary, for buttons and emphasis. */
  primary: '#1062d3',
  /** Links, a touch brighter so they hold up on white. */
  link: '#1d6bde',
  ground: '#f1f4f7',
  card: '#ffffff',
  text: '#1c222b',
  muted: '#5b6472',
  /** Footer text on the dark band. */
  onBandMuted: '#9aa5b8',
  hairline: '#dadee3',
} as const;

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export interface EmailBrand {
  companyName: string;
  supportEmail: string;
  address: string | null;
  logoUrl: string | null;
  /** The picture for this particular email, if one is set. */
  imageUrl: string | null;
  imageAlt: string | null;
  /** Whatever the admin arranged, in their order. Empty renders no row at all. */
  social: {
    label: string;
    url: string;
    /** An uploaded PNG/JPEG/GIF. Null falls back to the letterform. */
    iconUrl: string | null;
    glyph: string;
  }[];
  footer: {
    legalName: string;
    addressLine: string | null;
    optInNote: string | null;
    unsubscribeNote: string | null;
    unsubscribeUrl: string | null;
  };
}

/** For values placed inside an HTML attribute in the layout itself. */
export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Inline the styles the body's own tags need.
 *
 * Gmail drops a `<style>` block on forwarded mail and Outlook ignores much of
 * it, so every rule has to live on the element. The editor's own inline styles
 * — a font, a colour, an alignment somebody chose — are appended *after* these,
 * so a deliberate choice always wins over the default.
 */
const CONTENT_STYLES: Record<string, string> = {
  h1: 'margin:0 0 12px;font-size:22px;font-weight:600;line-height:1.3;color:#0f172a;',
  h2: 'margin:22px 0 8px;font-size:18px;font-weight:600;line-height:1.3;color:#0f172a;',
  h3: 'margin:18px 0 6px;font-size:16px;font-weight:600;color:#0f172a;',
  h4: 'margin:16px 0 6px;font-size:14px;font-weight:600;color:#334155;',
  h5: 'margin:14px 0 4px;font-size:13px;font-weight:600;color:#334155;',
  h6: 'margin:14px 0 4px;font-size:12px;font-weight:600;color:#334155;',
  p: 'margin:0 0 14px;',
  ul: 'margin:0 0 14px;padding-left:20px;',
  ol: 'margin:0 0 14px;padding-left:20px;',
  li: 'margin:0 0 6px;',
  blockquote: `margin:0 0 14px;padding:10px 14px;background:${BRAND.ground};border-left:3px solid ${BRAND.primary};color:${BRAND.muted};`,
  code: `font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:${BRAND.ground};padding:2px 5px;border-radius:4px;word-break:break-all;`,
  pre: `font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:${BRAND.ground};padding:12px;border-radius:6px;overflow-x:auto;`,
  a: `color:${BRAND.link};text-decoration:underline;`,
  hr: `border:0;border-top:1px solid ${BRAND.hairline};margin:22px 0;`,
  strong: 'font-weight:600;',
  b: 'font-weight:600;',
  table: 'border-collapse:collapse;width:100%;margin:0 0 14px;',
  th: `border:1px solid ${BRAND.hairline};padding:8px 10px;text-align:left;background:${BRAND.ground};font-weight:600;`,
  td: `border:1px solid ${BRAND.hairline};padding:8px 10px;`,
  img: 'max-width:100%;height:auto;border-radius:8px;',
};

export function styleContent(html: string): string {
  return html.replace(
    /<([a-z0-9]+)((?:\s[^>]*)?)>/gi,
    (whole, tag: string, rest: string) => {
      const base = CONTENT_STYLES[tag.toLowerCase()];
      if (!base) return whole;

      // Merge rather than replace: the editor may have set a font or a colour
      // on this very element, and overwriting it would silently discard what
      // somebody chose.
      const existing = /\sstyle\s*=\s*"([^"]*)"/i.exec(rest);
      if (existing) {
        const merged = `${base}${existing[1]}`;
        return `<${tag}${rest.replace(existing[0], ` style="${merged}"`)}>`;
      }
      return `<${tag}${rest} style="${base}">`;
    },
  );
}

/** The size an icon is drawn at. Upload at 128px so a 3× screen stays crisp. */
const ICON_POINTS = 32;

/**
 * The social row.
 *
 * An uploaded icon is used when there is one, and a letterform in an outlined
 * circle when there is not — so a network added at four in the afternoon still
 * appears in the five o'clock email, icon or no icon.
 *
 * The fallback is not a placeholder for something better: SVG does not render
 * in Gmail or Outlook, and a blocked or broken image in a footer looks worse
 * than a letter. The letterform arrives intact everywhere, including in a
 * client with images switched off entirely — which is a lot of them.
 */
function socialRow(social: EmailBrand['social']): string {
  if (social.length === 0) return '';

  const cells = social
    .map((s) => {
      const url = escapeAttr(s.url);
      const label = escapeAttr(s.label);

      const inner = s.iconUrl
        ? `<img src="${escapeAttr(s.iconUrl)}" alt="${label}" width="${ICON_POINTS}" height="${ICON_POINTS}" style="display:block;width:${ICON_POINTS}px;height:${ICON_POINTS}px;border:0;border-radius:50%;" />`
        : `<span style="display:inline-block;width:${ICON_POINTS}px;height:${ICON_POINTS}px;line-height:${ICON_POINTS - 2}px;text-align:center;border:1px solid rgba(255,255,255,0.35);border-radius:50%;color:#ffffff;font-family:${FONT};font-size:13px;font-weight:600;">${s.glyph}</span>`;

      return `<td style="padding:0 5px;">
        <a href="${url}" title="${label}" style="display:inline-block;text-decoration:none;color:#ffffff;">${inner}</a>
      </td>`;
    })
    .join('');

  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 18px;"><tr>${cells}</tr></table>`;
}

/**
 * The whole message.
 *
 * Order matches the design: brand band with the logo, the picture for this
 * email inset on that band, the white card with the words, then the band again
 * with the social row and the legal lines.
 */
export function wrapHtml(contentHtml: string, brand: EmailBrand): string {
  const company = escapeAttr(brand.companyName);
  const support = escapeAttr(brand.supportEmail);
  const year = new Date().getFullYear();

  const header = brand.logoUrl
    ? `<img src="${escapeAttr(brand.logoUrl)}" alt="${company}" height="34" style="height:34px;display:inline-block;border:0;vertical-align:middle;" />
       <span style="display:inline-block;vertical-align:middle;margin-left:10px;font-family:${FONT};font-size:19px;font-weight:600;letter-spacing:-0.01em;color:#ffffff;">${company}</span>`
    : `<span style="font-family:${FONT};font-size:20px;font-weight:600;letter-spacing:-0.01em;color:#ffffff;">${company}</span>`;

  // On the band, not on the white card — the picture reads as part of the
  // masthead rather than as something dropped into the message.
  const hero = brand.imageUrl
    ? `<tr>
        <td style="background:${BRAND.band};padding:0 20px 22px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bandDeep};border-radius:12px;">
            <tr><td style="padding:8px;">
              <img src="${escapeAttr(brand.imageUrl)}" alt="${escapeAttr(brand.imageAlt ?? company)}" width="100%" style="display:block;width:100%;max-width:100%;height:auto;border:0;border-radius:8px;" />
            </td></tr>
          </table>
        </td>
      </tr>`
    : '';

  const footerLines: string[] = [
    `<div style="font-style:italic;margin-bottom:10px;">&copy; ${year} ${escapeAttr(brand.footer.legalName)}. All rights reserved.</div>`,
  ];
  if (brand.footer.addressLine) {
    footerLines.push(
      `<div style="margin-bottom:10px;text-decoration:underline;">${escapeAttr(brand.footer.addressLine)}</div>`,
    );
  }
  if (brand.footer.optInNote) {
    footerLines.push(`<div style="margin-bottom:8px;">${escapeAttr(brand.footer.optInNote)}</div>`);
  }
  if (brand.footer.unsubscribeNote) {
    // The link is only rendered when there is somewhere for it to go. An
    // "unsubscribe" that does nothing is worse than none at all — it is the
    // sentence people click when they have already had enough.
    const target = brand.footer.unsubscribeUrl ?? `mailto:${brand.supportEmail}?subject=Unsubscribe`;
    footerLines.push(
      `<div>${escapeAttr(brand.footer.unsubscribeNote)} <a href="${escapeAttr(target)}" style="color:#ffffff;font-weight:600;text-decoration:underline;">unsubscribe</a>.</div>`,
    );
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${company}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.ground};-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.ground};padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;border-radius:14px;overflow:hidden;border:1px solid ${BRAND.hairline};">

    <tr>
      <td align="center" style="background:${BRAND.band};padding:24px 20px ${brand.imageUrl ? '20px' : '24px'};">
        ${header}
      </td>
    </tr>

    ${hero}

    <tr>
      <td style="background:${BRAND.card};padding:30px 28px;font-family:${FONT};font-size:15px;line-height:1.62;color:${BRAND.text};">
${styleContent(contentHtml)}
      </td>
    </tr>

    <tr>
      <td align="center" style="background:${BRAND.band};padding:24px 24px 26px;font-family:${FONT};font-size:12px;line-height:1.65;color:${BRAND.onBandMuted};text-align:center;">
        ${socialRow(brand.social)}
        ${footerLines.join('\n        ')}
        <div style="margin-top:12px;">
          Questions? <a href="mailto:${support}" style="color:#ffffff;text-decoration:underline;">${support}</a>
        </div>
      </td>
    </tr>

  </table>
</td></tr>
</table>
</body>
</html>`;
}

/** The plain-text alternative. Same words, no frame to speak of. */
export function wrapText(content: string, brand: EmailBrand): string {
  const lines = [content, '', '—', brand.companyName];
  if (brand.footer.addressLine) lines.push(brand.footer.addressLine);
  lines.push(`Questions? ${brand.supportEmail}`);
  if (brand.footer.optInNote) lines.push('', brand.footer.optInNote);
  return lines.join('\n');
}
