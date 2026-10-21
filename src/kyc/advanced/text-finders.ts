/**
 * Finding a date, a name and an address in a document's text (spec 2026-10-21 §7.3).
 * Pure, so every rule that decides a customer's level can be tested to the edge.
 */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';

function iso(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // 31/02 and friends
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Every date in the text, in reading order. Each holds one or two ISO readings:
 * two when day and month could swap (03/04/2026), day-first reading first.
 */
export function findDates(text: string): string[][] {
  const found: { at: number; readings: string[] }[] = [];
  const push = (at: number, readings: (string | null)[]) => {
    const ok = [...new Set(readings.filter((r): r is string => r !== null))];
    if (ok.length) found.push({ at, readings: ok });
  };
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) push(m.index, [iso(+m[1], +m[2], +m[3])]);
  for (const m of text.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/g)) {
    const [a, b, y] = [+m[1], +m[2], +m[3]];
    push(m.index, a <= 12 && b <= 12 ? [iso(y, b, a), iso(y, a, b)] : [iso(y, b, a)]);
  }
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON},?\\s+(\\d{4})\\b`, 'gi'))) {
    push(m.index, [iso(+m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1])]);
  }
  for (const m of text.matchAll(new RegExp(`\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'))) {
    push(m.index, [iso(+m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2])]);
  }
  return found.sort((x, y) => x.at - y.at).map((f) => f.readings);
}

/** One date from an ID field, day first. Null when there is none. */
export function toIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  return findDates(value)[0]?.[0] ?? null;
}

/**
 * The latest date in the text. An ambiguous date counts as its EARLIER reading,
 * so "is it recent enough?" is never answered by the kinder guess.
 */
export function latestDate(text: string, today: string, opts: { allowFuture: boolean }): string | null {
  let best: string | null = null;
  for (const readings of findDates(text)) {
    const usable = opts.allowFuture ? readings : readings.filter((r) => r <= today);
    if (!usable.length) continue;
    const conservative = [...usable].sort()[0];
    if (best === null || conservative > best) best = conservative;
  }
  return best;
}

/** On or after the same day `months` calendar months before today (clamped to the month's last day). */
export function withinMonths(date: string, today: string, months: number): boolean {
  const [y, m, d] = today.split('-').map(Number);
  const back = new Date(Date.UTC(y, m - 1 - months, 1));
  const lastDay = new Date(Date.UTC(back.getUTCFullYear(), back.getUTCMonth() + 1, 0)).getUTCDate();
  const cutoff = iso(back.getUTCFullYear(), back.getUTCMonth() + 1, Math.min(d, lastDay));
  return cutoff !== null && date >= cutoff;
}

function words(s: string): Set<string> {
  return new Set(
    s
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}
const partsOf = (s: string) => [...words(s)];

/** Every word of the first name and of the last name, as whole words anywhere in the text. */
export function nameInText(text: string, name: { firstName: string; lastName: string }): 'FULL' | 'PARTIAL' | 'NONE' {
  const have = words(text);
  const all = (ws: string[]) => ws.length > 0 && ws.every((w) => have.has(w));
  const first = all(partsOf(name.firstName));
  const last = all(partsOf(name.lastName));
  return first && last ? 'FULL' : first || last ? 'PARTIAL' : 'NONE';
}

const STREET_FILLER = new Set(['street', 'st', 'road', 'rd', 'avenue', 'ave', 'close', 'crescent', 'lane', 'way', 'drive', 'off', 'by', 'the', 'and', 'estate', 'plot', 'no', 'house']);
const STATE_ALIASES: Record<string, string[][]> = { fct: [['fct'], ['abuja']] };

/**
 * The address typed at Basic, in the document: MATCH needs the state and either
 * the street's main words or the city; PARTIAL is the state alone.
 */
export function addressInText(
  text: string,
  addr: { street: string | null; city: string | null; state: string | null },
): 'MATCH' | 'PARTIAL' | 'NONE' {
  const have = words(text);
  const all = (ws: string[]) => ws.length > 0 && ws.every((w) => have.has(w));
  const stateWords = partsOf(addr.state ?? '');
  const stateOptions = STATE_ALIASES[stateWords.join(' ')] ?? [stateWords];
  if (!stateOptions.some(all)) return 'NONE';
  const street = partsOf(addr.street ?? '')
    .filter((w) => w.length >= 3 && !STREET_FILLER.has(w) && !/^\d+$/.test(w))
    .slice(0, 3);
  const city = partsOf(addr.city ?? '');
  return all(street) || all(city) ? 'MATCH' : 'PARTIAL';
}
