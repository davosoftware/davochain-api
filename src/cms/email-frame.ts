/**
 * The parts of an email around the words (design approved 22 Oct 2026: "look C",
 * receipt layout 1): a coloured panel at the top of the card, a receipt list
 * for money emails, and one button.
 *
 * These live in code, per template, and are NOT editable from the dashboard: an
 * admin rewording a message can never break a receipt. Values are filled in and
 * HTML-escaped here; a row whose value was not passed is left out.
 */

export type PanelKind = 'done' | 'code' | 'progress' | 'problem' | 'security';

/** Blue for done and for codes, amber for in progress, red for "didn't go through", navy for security. */
export const PANEL_COLOURS: Record<PanelKind, string> = {
  done: '#1062d3',
  code: '#1062d3',
  progress: '#b7791f',
  problem: '#c0392b',
  security: '#102c58',
};

/** The status chip on a receipt: the words and their colours. */
export const STATUS_CHIPS: Record<'done' | 'progress' | 'problem', { text: string; fg: string; bg: string }> = {
  done: { text: 'Completed', fg: '#0e7a45', bg: '#e3f6ec' },
  progress: { text: 'In progress', fg: '#8a5a00', bg: '#fdf1d8' },
  problem: { text: 'Not completed', fg: '#a8321f', bg: '#fbe6e2' },
};

export interface FrameDef {
  panel: {
    kind: PanelKind;
    /** Small capitals above the value, e.g. "You bought". */
    label: string;
    /** The big line: an amount, a code, or a short headline. */
    value: string;
    /** One line under it, e.g. "for ₦{{fromAmount}}". */
    sub?: string;
  };
  /** Receipt rows: [label, value with {{placeholders}}]. */
  details?: Array<[string, string]>;
  /** The chip on the receipt. Defaults from the panel kind; false for none. */
  status?: 'done' | 'progress' | 'problem' | false;
  /** A button. Omitted = "Open {{companyName}}" to the website; false = none. */
  button?: { label: string; url: string } | false;
}

/** The frame with every value filled in and escaped, ready for the layout. */
export interface Frame {
  kind: PanelKind;
  label: string;
  value: string;
  sub: string | null;
  details: Array<{ label: string; value: string; mono: boolean }>;
  status: { text: string; fg: string; bg: string } | null;
  button: { label: string; url: string } | null;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** Fills a frame string; null when any placeholder in it has no value (the row or line is then left out). */
function fill(source: string, values: Record<string, string | null | undefined>): string | null {
  let missing = false;
  const out = source.replace(PLACEHOLDER, (_whole, name: string) => {
    const v = values[name];
    if (v === undefined || v === null || v === '') {
      missing = true;
      return '';
    }
    return escapeHtml(String(v));
  });
  return missing ? null : out;
}

/** References and hashes read best in a fixed-width face. */
const MONO_LABELS = new Set(['Reference', 'Transaction hash', 'Address', 'Destination tag']);

/** Only http(s) links become buttons. */
const safeUrl = (url: string | null): string | null => (url && /^https?:\/\//i.test(url.replace(/&amp;/g, '&')) ? url : null);

export function buildFrame(def: FrameDef, values: Record<string, string | null | undefined>): Frame {
  const kind = def.panel.kind;
  const details = (def.details ?? [])
    .map(([label, source]) => ({ label: escapeHtml(label), value: fill(source, values), mono: MONO_LABELS.has(label) }))
    .filter((d): d is { label: string; value: string; mono: boolean } => d.value !== null && d.value.trim() !== '');

  const statusKey = def.status === false ? null : (def.status ?? (kind === 'done' || kind === 'progress' || kind === 'problem' ? kind : null));
  let button: Frame['button'] = null;
  if (def.button !== false) {
    const b = def.button ?? { label: 'Open {{companyName}}', url: '{{websiteUrl}}' };
    const url = safeUrl(fill(b.url, values));
    const label = fill(b.label, values);
    if (url && label) button = { label, url };
  }

  return {
    kind,
    label: fill(def.panel.label, values) ?? escapeHtml(def.panel.label.replace(PLACEHOLDER, '').trim()),
    value: fill(def.panel.value, values) ?? '',
    sub: def.panel.sub ? fill(def.panel.sub, values) : null,
    details,
    status: details.length > 0 && statusKey ? STATUS_CHIPS[statusKey] : null,
    button,
  };
}

/** The variables shown as money get thousands separators: "200000.00" → "200,000.00". */
export const MONEY_VARIABLES = ['amount', 'fee', 'fromAmount', 'toAmount', 'rate'];

export function groupThousands(value: string): string {
  const m = /^(\d+)(\.\d+)?$/.exec(value.trim());
  if (!m) return value;
  return m[1].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (m[2] ?? '');
}

/** "22 Oct 2026, 2:14 PM" in Lagos time, for the Date row. */
export function lagosDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(at)
    .replace(/\bam\b/, 'AM')
    .replace(/\bpm\b/, 'PM');
}
