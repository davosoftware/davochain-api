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

import { PANEL_COLOURS, type Frame } from './email-frame';

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
  /** The soft blue page every email sits on (look C). */
  ground: '#eaf1fc',
  card: '#ffffff',
  cardEdge: '#dbe6f7',
  hairlineSoft: '#eef1f5',
  footerText: '#5b6a85',
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
  /** Where the header logo comes from: "cid:…" when it travels inside the email, else a URL, else none. */
  logoSrc: string | null;
  /** The public website, for the button. */
  websiteUrl: string;
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
        : `<span style="display:inline-block;width:${ICON_POINTS}px;height:${ICON_POINTS}px;line-height:${ICON_POINTS - 2}px;text-align:center;border:1px solid ${BRAND.cardEdge};background-color:#ffffff;border-radius:50%;color:${BRAND.band};font-family:${FONT};font-size:13px;font-weight:600;">${s.glyph}</span>`;

      return `<td style="padding:0 5px;">
        <a href="${url}" title="${label}" style="display:inline-block;text-decoration:none;color:${BRAND.band};">${inner}</a>
      </td>`;
    })
    .join('');

  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 18px;"><tr>${cells}</tr></table>`;
}

/**
 * The whole message ("look C", approved 22 Oct 2026).
 *
 * A soft blue page; the logo and name centred above a white rounded card; in
 * the card, a coloured panel with the one thing that matters (an amount, a
 * code or a headline), then the words, the receipt list, one button; the
 * footer sits quietly under the card.
 */
export function wrapHtml(contentHtml: string, brand: EmailBrand, frame?: Frame | null): string {
  const company = escapeAttr(brand.companyName);
  const support = escapeAttr(brand.supportEmail);
  const year = new Date().getFullYear();

  const name = `<span style="font-family:${FONT};font-size:19px;font-weight:700;letter-spacing:-0.01em;color:${BRAND.band};vertical-align:middle;">${company}</span>`;
  const header = brand.logoSrc
    ? `<img src="${escapeAttr(brand.logoSrc)}" alt="${company}" height="36" style="height:36px;width:auto;display:inline-block;border:0;vertical-align:middle;" />
       <span style="display:inline-block;width:8px;"></span>${name}`
    : `<span style="display:inline-block;width:22px;height:22px;border-radius:6px;background-color:${BRAND.primary};vertical-align:middle;"></span>
       <span style="display:inline-block;width:8px;"></span>${name}`;

  const panel = frame ? panelRow(frame) : '';

  // The picture an admin set for this email, inside the card under the panel.
  const hero = brand.imageUrl
    ? `<tr><td style="padding:22px 28px 0;">
        <img src="${escapeAttr(brand.imageUrl)}" alt="${escapeAttr(brand.imageAlt ?? company)}" width="100%" style="display:block;width:100%;max-width:100%;height:auto;border:0;border-radius:10px;" />
      </td></tr>`
    : '';

  const details = frame && frame.details.length > 0 ? detailsRow(frame) : '';
  const button = frame?.button ? buttonRow(frame.button) : '';

  const footerLines: string[] = [
    `<div style="margin-bottom:8px;">&copy; ${year} ${escapeAttr(brand.footer.legalName)}. All rights reserved.</div>`,
  ];
  if (brand.footer.addressLine) {
    footerLines.push(`<div style="margin-bottom:8px;">${escapeAttr(brand.footer.addressLine)}</div>`);
  }
  if (brand.footer.optInNote) {
    footerLines.push(`<div style="margin-bottom:8px;">${escapeAttr(brand.footer.optInNote)}</div>`);
  }
  if (brand.footer.unsubscribeNote) {
    // Only rendered with somewhere to go: an "unsubscribe" that does nothing is worse than none.
    const target = brand.footer.unsubscribeUrl ?? `mailto:${brand.supportEmail}?subject=Unsubscribe`;
    footerLines.push(
      `<div>${escapeAttr(brand.footer.unsubscribeNote)} <a href="${escapeAttr(target)}" style="color:${BRAND.band};text-decoration:underline;">unsubscribe</a>.</div>`,
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
<body style="margin:0;padding:0;background-color:${BRAND.ground};-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${BRAND.ground}" style="background-color:${BRAND.ground};">
<tr><td align="center" style="padding:28px 12px 32px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">

    <tr><td align="center" style="padding:0 0 18px;">${header}</td></tr>

    <tr><td>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${BRAND.card}" style="background-color:${BRAND.card};border-radius:16px;border:1px solid ${BRAND.cardEdge};border-collapse:separate;overflow:hidden;">
        ${panel}
        ${hero}
        <tr>
          <td style="padding:26px 28px 6px;font-family:${FONT};font-size:15px;line-height:1.62;color:${BRAND.text};">
${styleContent(contentHtml)}
          </td>
        </tr>
        ${details}
        ${button}
        <tr><td style="height:14px;line-height:14px;font-size:0;">&nbsp;</td></tr>
      </table>
    </td></tr>

    <tr>
      <td align="center" style="padding:22px 20px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${BRAND.footerText};text-align:center;">
        ${socialRow(brand.social)}
        ${footerLines.join('\n        ')}
        <div style="margin-top:10px;">
          Questions? <a href="mailto:${support}" style="color:${BRAND.band};font-weight:600;text-decoration:none;">${support}</a>
        </div>
      </td>
    </tr>

  </table>
</td></tr>
</table>
</body>
</html>`;
}

/** The coloured panel at the top of the card. */
function panelRow(frame: Frame): string {
  const colour = PANEL_COLOURS[frame.kind];
  const isCode = frame.kind === 'code';
  // Long headlines ("Your password was changed") get a smaller size than amounts.
  const plainLength = frame.value.replace(/&[a-z#0-9]+;/gi, 'x').length;
  const valueStyle = isCode
    ? `font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:8px;`
    : `font-family:${FONT};font-size:${plainLength > 22 ? 21 : 28}px;font-weight:700;letter-spacing:-0.01em;`;
  return `<tr>
          <td align="center" bgcolor="${colour}" style="background-color:${colour};padding:26px 24px 24px;text-align:center;color:#ffffff;border-radius:16px 16px 0 0;">
            <div style="font-family:${FONT};font-size:12px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#ffffff;opacity:0.85;">${frame.label}</div>
            ${frame.value ? `<div style="${valueStyle}line-height:1.25;color:#ffffff;margin-top:6px;">${frame.value}</div>` : ''}
            ${frame.sub ? `<div style="font-family:${FONT};font-size:14px;color:#ffffff;opacity:0.92;margin-top:4px;">${frame.sub}</div>` : ''}
          </td>
        </tr>`;
}

/** The receipt list: label left, value right, a hairline between rows, the status chip last but one. */
function detailsRow(frame: Frame): string {
  const rows = frame.details.map((d) => ({ label: d.label, value: d.mono ? mono(d.value) : d.value }));
  if (frame.status) {
    const chip = `<span style="display:inline-block;padding:3px 10px;border-radius:999px;background-color:${frame.status.bg};color:${frame.status.fg};font-weight:600;font-size:12.5px;">${frame.status.text}</span>`;
    // Before the reference, which reads best last.
    const at = rows.findIndex((r) => r.label === 'Reference');
    rows.splice(at === -1 ? rows.length : at, 0, { label: 'Status', value: chip });
  }
  const body = rows
    .map((r, i) => {
      const edge = i < rows.length - 1 ? `border-bottom:1px solid ${BRAND.hairlineSoft};` : '';
      return `<tr>
              <td style="padding:10px 0;${edge}font-family:${FONT};font-size:13.5px;color:${BRAND.muted};vertical-align:top;white-space:nowrap;">${r.label}</td>
              <td align="right" style="padding:10px 0 10px 16px;${edge}font-family:${FONT};font-size:13.5px;color:${BRAND.text};font-weight:600;text-align:right;word-break:break-word;">${r.value}</td>
            </tr>`;
    })
    .join('');
  return `<tr><td style="padding:6px 28px 4px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-top:1px solid ${BRAND.hairlineSoft};">${body}</table>
        </td></tr>`;
}

const mono = (value: string) =>
  `<span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;font-weight:500;word-break:break-all;">${value}</span>`;

/** A button that survives Outlook: a coloured table cell around the link. */
function buttonRow(button: { label: string; url: string }): string {
  return `<tr><td align="center" style="padding:20px 28px 8px;">
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr>
            <td align="center" bgcolor="${BRAND.primary}" style="background-color:${BRAND.primary};border-radius:10px;">
              <a href="${button.url}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">${button.label}</a>
            </td>
          </tr></table>
        </td></tr>`;
}

/** Back from the escaped form the frame keeps, for the plain-text version. */
function unescapeHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** The plain-text alternative: the panel, the words, the receipt, the button's link. */
export function wrapText(content: string, brand: EmailBrand, frame?: Frame | null): string {
  const lines: string[] = [brand.companyName, ''];
  if (frame) {
    const head = [frame.label, frame.value, frame.sub].filter(Boolean).map((s) => unescapeHtml(s!));
    lines.push(head.join(' — '), '');
  }
  lines.push(content);
  if (frame && frame.details.length > 0) {
    lines.push('');
    for (const d of frame.details) lines.push(`${unescapeHtml(d.label)}: ${unescapeHtml(d.value)}`);
    if (frame.status) lines.push(`Status: ${frame.status.text}`);
  }
  if (frame?.button) lines.push('', `${unescapeHtml(frame.button.label)}: ${unescapeHtml(frame.button.url)}`);
  lines.push('', '—', brand.companyName);
  if (brand.footer.addressLine) lines.push(brand.footer.addressLine);
  lines.push(`Questions? ${brand.supportEmail}`);
  if (brand.footer.optInNote) lines.push('', brand.footer.optInNote);
  return lines.join('\n');
}
