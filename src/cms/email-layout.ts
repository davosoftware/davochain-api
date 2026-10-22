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
 * The palette of the design approved 22 Oct 2026 (the "Davopay-style" samples):
 * the logo's own bright blue #135CF7 for the header and footer, its light blue
 * #66B3FF for accents, deep navy text, and a soft blue page.
 */
export const BRAND = {
  /** The logo's blue: card header, buttons, footer card. */
  primary: '#135CF7',
  /** The logo's light blue: the footer divider. */
  accent: '#66B3FF',
  /** Links and text on pale blue. */
  link: '#0B45C2',
  /** The soft blue page every email sits on. */
  ground: '#F3F6FD',
  /** Pale blue boxes: the code box, the safety note, secondary buttons. */
  tint: '#F5F8FF',
  tintStrong: '#EAF1FF',
  card: '#FFFFFF',
  /** Headings, amounts, values. */
  ink: '#0B1530',
  /** Body text. */
  text: '#3B4565',
  /** Row labels. */
  muted: '#5B6585',
  hairline: '#EDF0F7',
  /** Text on the blue footer. */
  onBlue: '#EEF3FF',
} as const;

const FONT = "'Inter Tight',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace";

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
  h1: `margin:0 0 12px;font-size:22px;font-weight:600;line-height:1.3;color:${BRAND.ink};`,
  h2: `margin:22px 0 8px;font-size:18px;font-weight:600;line-height:1.3;color:${BRAND.ink};`,
  h3: `margin:18px 0 6px;font-size:16px;font-weight:600;color:${BRAND.ink};`,
  h4: `margin:16px 0 6px;font-size:14px;font-weight:600;color:${BRAND.ink};`,
  h5: `margin:14px 0 4px;font-size:13px;font-weight:600;color:${BRAND.ink};`,
  h6: `margin:14px 0 4px;font-size:12px;font-weight:600;color:${BRAND.ink};`,
  p: 'margin:0 0 14px;',
  ul: 'margin:0 0 14px;padding-left:20px;',
  ol: 'margin:0 0 14px;padding-left:20px;',
  li: 'margin:0 0 6px;',
  blockquote: `margin:0 0 14px;padding:10px 14px;background:${BRAND.tint};border-left:3px solid ${BRAND.primary};color:${BRAND.muted};`,
  code: `font-family:${MONO};font-size:13px;background:${BRAND.tint};padding:2px 5px;border-radius:4px;word-break:break-all;`,
  pre: `font-family:${MONO};font-size:13px;background:${BRAND.tint};padding:12px;border-radius:6px;overflow-x:auto;`,
  a: `color:${BRAND.primary};font-weight:600;text-decoration:underline;`,
  hr: `border:0;border-top:1px solid ${BRAND.hairline};margin:22px 0;`,
  strong: `font-weight:700;color:${BRAND.ink};`,
  b: 'font-weight:600;',
  table: 'border-collapse:collapse;width:100%;margin:0 0 14px;',
  th: `border:1px solid ${BRAND.hairline};padding:8px 10px;text-align:left;background:${BRAND.tint};font-weight:600;`,
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

/**
 * A solid colour that dark mode leaves alone.
 *
 * Gmail's apps and Outlook.com "helpfully" recolour backgrounds in dark mode,
 * which turns the brand blue into a muddy navy. They recolour
 * background-color but never a background-image, so the same colour is also
 * laid down as a one-colour gradient.
 */
const solid = (colour: string) => `background-color:${colour};background-image:linear-gradient(${colour},${colour});`;

/**
 * The dark version, for mail apps that ask (Apple Mail, iOS Mail, Outlook):
 * a deep navy page and card, light text, and the brand blue kept exactly as
 * it is. The `[data-ogsb]` copies are how Outlook.com applies it.
 */
const DARK_RULES: [string, string][] = [
  ['.dm-page', 'background-color:#070E22 !important;'],
  ['.dm-card', 'background-color:#0E1A3A !important;'],
  ['.dm-tint', 'background-color:#13224A !important;'],
  ['.dm-ink, .dm-content strong, .dm-content b, .dm-content h1, .dm-content h2, .dm-content h3, .dm-content h4, .dm-content h5, .dm-content h6', 'color:#FFFFFF !important;'],
  ['.dm-text, .dm-content', 'color:#C4CEE8 !important;'],
  ['.dm-muted', 'color:#93A3CC !important;'],
  ['.dm-hair', 'border-color:#1D2C57 !important;'],
  ['.dm-link, .dm-content a', 'color:#66B3FF !important;'],
  ['.dm-pill', 'background-color:#1A2A55 !important;color:#FFFFFF !important;'],
  ['.dm-logotile', 'background-color:#FFFFFF !important;border-radius:8px !important;padding:4px !important;'],
];
const darkCss = (prefix: string) =>
  DARK_RULES.map(([sel, body]) => `${sel.split(', ').map((x) => prefix + x).join(', ')} { ${body} }`).join('\n    ');
const DARK_CSS = `@media (prefers-color-scheme: dark) {
    ${darkCss('')}
  }
  ${darkCss('[data-ogsb] ')}`;

/** The size a social icon is drawn at. Upload at 128px so a 3× screen stays crisp. */
const ICON_POINTS = 40;

/**
 * The social row, on the blue footer.
 *
 * An uploaded icon is used when there is one, and a letterform in a white
 * circle when there is not — so a network added at four in the afternoon still
 * appears in the five o'clock email. SVG does not render in Gmail or Outlook,
 * and the letterform arrives intact everywhere, images on or off.
 */
function socialRow(social: EmailBrand['social']): string {
  if (social.length === 0) return '';

  const cells = social
    .map((s) => {
      const url = escapeAttr(s.url);
      const label = escapeAttr(s.label);

      const inner = s.iconUrl
        ? `<img src="${escapeAttr(s.iconUrl)}" alt="${label}" width="${ICON_POINTS}" height="${ICON_POINTS}" style="display:block;width:${ICON_POINTS}px;height:${ICON_POINTS}px;border:0;border-radius:50%;" />`
        : `<span style="display:inline-block;width:${ICON_POINTS}px;height:${ICON_POINTS}px;line-height:${ICON_POINTS}px;text-align:center;background-color:#FFFFFF;border-radius:50%;color:${BRAND.primary};font-family:${FONT};font-size:15px;font-weight:800;">${s.glyph}</span>`;

      return `<td style="padding:0 6px;"><a href="${url}" title="${label}" style="display:inline-block;text-decoration:none;">${inner}</a></td>`;
    })
    .join('');

  return `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:24px auto 0;"><tr>${cells}</tr></table>`;
}

/** The small word in the pill at the top right: what kind of email this is. */
function kindPill(frame: Frame | null | undefined): string | null {
  if (!frame) return null;
  if (frame.kind === 'code') return 'SECURITY CODE';
  if (frame.details.length > 0) return 'RECEIPT';
  if (frame.kind === 'security') return 'SECURITY';
  return null;
}

/** The mark in the white circle on the header: a tick, a key, an hourglass, a shield, or "!". */
const HEADER_GLYPH: Record<Frame['kind'], string> = {
  done: '&#10003;',
  code: '&#128273;',
  progress: '&#8987;',
  problem: '!',
  security: '&#128737;',
};

/**
 * The whole message (design of 22 Oct 2026, after the "classic receipt" and
 * "token" samples).
 *
 * A soft blue page. Above the card: the logo and name on the left, a pill
 * saying what kind of email it is on the right. In the white card: a coloured
 * header with the one thing that matters (an amount or a headline), the code
 * in a dashed box when there is one, the words, the receipt list, one
 * full-width button, and a "we never ask for your PIN" note. Under the card,
 * a big blue footer with the logo, social icons, contact details and the
 * legal lines.
 */
export function wrapHtml(contentHtml: string, brand: EmailBrand, frame?: Frame | null): string {
  const company = escapeAttr(brand.companyName);
  const support = escapeAttr(brand.supportEmail);
  const website = escapeAttr(brand.websiteUrl);
  const year = new Date().getFullYear();

  const name = (colour: string, size: number, cls = '') =>
    `<span${cls ? ` class="${cls}"` : ''} style="font-family:${FONT};font-size:${size}px;line-height:${size + 6}px;font-weight:800;letter-spacing:-0.3px;color:${colour};vertical-align:middle;">${company}</span>`;
  const logo = (size: number) =>
    brand.logoSrc
      ? `<img src="${escapeAttr(brand.logoSrc)}" alt="${company}" height="${size}" style="display:inline-block;height:${size}px;width:auto;border:0;vertical-align:middle;" />`
      : `<span style="display:inline-block;width:${size - 8}px;height:${size - 8}px;border-radius:8px;${solid(BRAND.primary)}vertical-align:middle;"></span>`;

  const pill = kindPill(frame);
  const topBar = `<tr><td style="padding:0 8px 20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td align="left" valign="middle"><span class="dm-logotile" style="display:inline-block;vertical-align:middle;">${logo(32)}</span><span style="display:inline-block;width:10px;"></span>${name(BRAND.ink, 20, 'dm-ink')}</td>
      ${pill ? `<td align="right" valign="middle"><span class="dm-pill" style="display:inline-block;background-color:${BRAND.tintStrong};color:${BRAND.link};font-family:${FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:1px;padding:6px 12px;border-radius:999px;">${pill}</span></td>` : ''}
    </tr></table>
  </td></tr>`;

  // The picture an admin set for this email, inside the card under the header.
  const hero = brand.imageUrl
    ? `<tr><td class="px" style="padding:28px 40px 0;">
        <img src="${escapeAttr(brand.imageUrl)}" alt="${escapeAttr(brand.imageAlt ?? company)}" width="100%" style="display:block;width:100%;max-width:100%;height:auto;border:0;border-radius:14px;" />
      </td></tr>`
    : '';

  const footerLegal: string[] = [];
  if (brand.footer.optInNote) {
    footerLegal.push(`<p style="margin:20px 0 0;font-size:13px;line-height:21px;color:#FFFFFF;">${escapeAttr(brand.footer.optInNote)}</p>`);
  }
  if (brand.footer.unsubscribeNote) {
    // Only rendered with somewhere to go: an "unsubscribe" that does nothing is worse than none.
    const target = brand.footer.unsubscribeUrl ?? `mailto:${brand.supportEmail}?subject=Unsubscribe`;
    footerLegal.push(
      `<p style="margin:14px 0 0;font-size:12px;line-height:19px;color:${BRAND.onBlue};">${escapeAttr(brand.footer.unsubscribeNote)} <a href="${escapeAttr(target)}" style="color:#FFFFFF;font-weight:700;text-decoration:underline;">Unsubscribe</a>.</p>`,
    );
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<title>${company}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700;800&amp;family=JetBrains+Mono:wght@500;700&amp;display=swap" rel="stylesheet" />
<style>
  body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  table { border-collapse: collapse; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
  img { border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
  @media only screen and (max-width: 620px) {
    .container { width: 100% !important; }
    .px { padding-left: 20px !important; padding-right: 20px !important; }
    .amount { font-size: 38px !important; line-height: 42px !important; }
    .code { font-size: 28px !important; letter-spacing: 5px !important; }
  }
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  ${DARK_CSS}
</style>
</head>
<body class="dm-page" style="margin:0;padding:0;background-color:${BRAND.ground};-webkit-font-smoothing:antialiased;">
<table role="presentation" class="dm-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.ground}" style="background-color:${BRAND.ground};">
<tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;font-family:${FONT};color:${BRAND.ink};">

    ${topBar}

    <tr><td class="dm-card" bgcolor="${BRAND.card}" style="background-color:${BRAND.card};border-radius:24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        ${frame ? headerRow(frame) : ''}
        ${frame?.kind === 'code' ? codeRow(frame) : ''}
        ${hero}
        <tr>
          <td class="px dm-content" style="padding:32px 40px 8px;font-family:${FONT};font-size:15px;line-height:24px;color:${BRAND.text};">
${styleContent(contentHtml)}
          </td>
        </tr>
        ${frame && frame.details.length > 0 ? detailsRow(frame) : ''}
        ${frame?.button ? buttonRow(frame.button) : ''}
        ${safetyRow(company, support)}
      </table>
    </td></tr>

    <tr><td style="padding-top:24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.primary}" style="${solid(BRAND.primary)}border-radius:28px;">
      <tr>
      <td align="center" class="px" style="padding:40px 44px 36px;text-align:center;font-family:${FONT};color:#FFFFFF;">
        <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr>
          ${brand.logoSrc ? `<td bgcolor="#FFFFFF" style="background-color:#FFFFFF;border-radius:14px;padding:8px;">${logo(32)}</td><td style="width:12px;"></td>` : ''}
          <td valign="middle">${name('#FFFFFF', 22)}</td>
        </tr></table>
        ${socialRow(brand.social)}
        ${brand.footer.addressLine ? `<p style="margin:22px 0 0;font-size:14px;line-height:22px;color:${BRAND.onBlue};">${escapeAttr(brand.footer.addressLine)}</p>` : ''}
        <p style="margin:${brand.footer.addressLine ? 6 : 22}px 0 0;font-size:14px;line-height:20px;"><a href="mailto:${support}" style="color:#FFFFFF;font-weight:700;text-decoration:underline;">${support}</a></p>
        <table role="presentation" align="center" width="240" cellpadding="0" cellspacing="0" border="0" style="margin:24px auto 0;"><tr><td style="border-top:1px solid ${BRAND.accent};font-size:0;line-height:0;">&nbsp;</td></tr></table>
        <p style="margin:20px 0 0;font-size:15px;line-height:20px;font-weight:700;color:${BRAND.onBlue};"><a href="${website}" style="color:#FFFFFF;text-decoration:none;">Website</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="mailto:${support}" style="color:#FFFFFF;text-decoration:none;">Help &amp; support</a></p>
        ${footerLegal.join('\n        ')}
        <p style="margin:14px 0 0;font-size:12px;line-height:18px;font-weight:600;color:${BRAND.onBlue};">&copy; ${year} ${escapeAttr(brand.footer.legalName)}. All rights reserved.</p>
      </td>
      </tr>
      </table>
    </td></tr>

  </table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * The coloured header at the top of the card: a white circle with a mark, the
 * label, then the big value and one line under it. For a code email the code
 * itself goes in the dashed box below, so the header carries the label alone.
 */
function headerRow(frame: Frame): string {
  const colour = PANEL_COLOURS[frame.kind];
  const isCode = frame.kind === 'code';
  // Long headlines ("Your password was changed") get a smaller size than amounts.
  const plainLength = frame.value.replace(/&[a-z#0-9]+;/gi, 'x').length;
  const long = plainLength > 16;
  const value =
    !isCode && frame.value
      ? `<p${long ? '' : ' class="amount"'} style="margin:12px auto 0;max-width:460px;font-family:${FONT};font-size:${long ? 30 : 48}px;line-height:${long ? 36 : 52}px;font-weight:800;letter-spacing:${long ? -0.5 : -1}px;color:#FFFFFF;">${frame.value}</p>`
      : '';
  const sub = !isCode && frame.sub ? `<p style="margin:12px auto 0;max-width:440px;font-family:${FONT};font-size:16px;line-height:22px;color:#FFFFFF;">${frame.sub}</p>` : '';
  const label = isCode
    ? `<p style="margin:16px 0 0;font-family:${FONT};font-size:26px;line-height:32px;font-weight:800;letter-spacing:-0.4px;color:#FFFFFF;">${frame.label}</p>`
    : `<p style="margin:16px 0 0;font-family:${FONT};font-size:15px;line-height:20px;font-weight:600;color:#FFFFFF;">${frame.label}</p>`;
  return `<tr>
          <td class="px" align="center" bgcolor="${colour}" style="${solid(colour)}border-radius:24px 24px 0 0;padding:40px 40px 44px;color:#FFFFFF;text-align:center;">
            <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr>
              <td width="52" height="52" align="center" valign="middle" bgcolor="#FFFFFF" style="width:52px;height:52px;background-color:#FFFFFF;border-radius:26px;font-family:${FONT};font-size:24px;line-height:52px;font-weight:800;color:${colour};">${HEADER_GLYPH[frame.kind]}</td>
            </tr></table>
            ${label}
            ${value}
            ${sub}
          </td>
        </tr>`;
}

/** The code in a dashed box, big and spaced out so it is easy to read and type. */
function codeRow(frame: Frame): string {
  if (!frame.value) return '';
  return `<tr><td class="px" style="padding:28px 40px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="dm-tint" bgcolor="${BRAND.tint}" style="background-color:${BRAND.tint};border:2px dashed ${BRAND.primary};border-radius:18px;">
          <tr><td align="center" style="padding:22px 20px;text-align:center;">
            <p class="dm-muted" style="margin:0;font-family:${FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.7px;color:${BRAND.muted};">ENTER THIS CODE</p>
            <p class="code dm-ink" style="margin:10px 0 0;font-family:${MONO};font-size:36px;line-height:42px;font-weight:700;letter-spacing:8px;color:${BRAND.ink};">${frame.value}</p>
            ${frame.sub ? `<p class="dm-muted" style="margin:10px 0 0;font-family:${FONT};font-size:13px;line-height:19px;color:${BRAND.muted};">${frame.sub}. Never share it with anyone.</p>` : ''}
          </td></tr>
          </table>
        </td></tr>`;
}

/** The receipt list: label left, value right, a hairline between rows, the status chip before the reference. */
function detailsRow(frame: Frame): string {
  const rows = frame.details.map((d) => ({ label: d.label, value: d.mono ? mono(d.value) : d.value }));
  if (frame.status) {
    const chip = `<span style="display:inline-block;background-color:${frame.status.bg};color:${frame.status.fg};font-weight:700;font-size:13px;line-height:16px;padding:5px 12px;border-radius:999px;">${frame.status.text}</span>`;
    // Before the reference, which reads best last.
    const at = rows.findIndex((r) => r.label === 'Reference');
    rows.splice(at === -1 ? rows.length : at, 0, { label: 'Status', value: chip });
  }
  const body = rows
    .map((r, i) => {
      const edge = i < rows.length - 1 ? `border-bottom:1px solid ${BRAND.hairline};` : '';
      return `<tr>
              <td class="dm-muted dm-hair" valign="top" style="padding:14px 0;${edge}font-family:${FONT};font-size:15px;line-height:20px;color:${BRAND.muted};white-space:nowrap;">${r.label}</td>
              <td class="dm-ink dm-hair" align="right" style="padding:14px 0 14px 16px;${edge}font-family:${FONT};font-size:15px;line-height:20px;font-weight:600;color:${BRAND.ink};text-align:right;word-break:break-word;">${r.value}</td>
            </tr>`;
    })
    .join('');
  return `<tr><td class="px" style="padding:12px 40px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${body}</table>
        </td></tr>`;
}

const mono = (value: string) =>
  `<span style="font-family:${MONO};font-size:13px;font-weight:500;word-break:break-all;">${value}</span>`;

/** A full-width button that survives Outlook: a coloured table cell around the link. */
function buttonRow(button: { label: string; url: string }): string {
  return `<tr><td class="px" style="padding:20px 40px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td align="center" bgcolor="${BRAND.primary}" style="${solid(BRAND.primary)}border-radius:12px;">
              <a href="${button.url}" target="_blank" style="display:block;padding:15px 20px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:700;color:#FFFFFF;text-decoration:none;">${button.label}</a>
            </td>
          </tr></table>
        </td></tr>`;
}

/** The pale box at the bottom of every card: we never ask for your PIN. */
function safetyRow(company: string, support: string): string {
  return `<tr><td class="px" style="padding:24px 40px 36px;">
          <table role="presentation" class="dm-tint" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.tint}" style="background-color:${BRAND.tint};border-radius:12px;">
          <tr>
            <td valign="top" width="20" style="padding:16px 0 16px 18px;"><span style="display:inline-block;width:20px;height:20px;line-height:20px;text-align:center;border-radius:10px;${solid(BRAND.primary)}color:#FFFFFF;font-family:${FONT};font-size:12px;font-weight:800;">i</span></td>
            <td class="dm-text" style="padding:16px 18px 16px 12px;font-family:${FONT};font-size:13px;line-height:20px;color:${BRAND.text};">${company} will never ask for your PIN, password or code. Something doesn’t look right? <a class="dm-link" href="mailto:${support}" style="color:${BRAND.primary};font-weight:600;text-decoration:underline;">Contact support</a> right away.</td>
          </tr>
          </table>
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

/** The plain-text alternative: the header, the words, the receipt, the button's link. */
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
  lines.push('', `${brand.companyName} will never ask for your PIN, password or code.`);
  lines.push('', '—', brand.companyName);
  if (brand.footer.addressLine) lines.push(brand.footer.addressLine);
  lines.push(`Questions? ${brand.supportEmail}`);
  if (brand.footer.optInNote) lines.push('', brand.footer.optInNote);
  return lines.join('\n');
}

