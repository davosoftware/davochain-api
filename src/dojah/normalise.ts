import type { AmlCategory, AmlMatch, AmlParsed, NormalisedIdentity } from './dojah.types';

const MAX_MATCHES = 20;
const MAX_TEXT = 200;

function entityOf(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const e = (body as { entity?: unknown }).entity;
  return e && typeof e === 'object' && !Array.isArray(e) ? (e as Record<string, unknown>) : null;
}

function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/\s+/g, ' ');
  return s ? s.slice(0, 100) : null;
}

function isoDate(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
}

function gender(v: unknown): NormalisedIdentity['gender'] {
  const g = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (g === 'm' || g === 'male') return 'MALE';
  if (g === 'f' || g === 'female') return 'FEMALE';
  return 'UNKNOWN';
}

/** Principle 1: the only reader of a raw Dojah identity record. */
export function normaliseIdentity(body: unknown): NormalisedIdentity {
  const e = entityOf(body);
  const firstName = cleanName(e?.first_name);
  const middleName = cleanName(e?.middle_name);
  const lastName = cleanName(e?.last_name);
  const dateOfBirth = isoDate(e?.date_of_birth);
  const customerRef = typeof e?.customer === 'string' ? e.customer.slice(0, 100) : null;
  return {
    usable: !!(firstName && lastName && dateOfBirth),
    firstName,
    middleName,
    lastName,
    dateOfBirth,
    gender: gender(e?.gender),
    customerRef,
  };
}

function text(v: unknown, max = MAX_TEXT): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

function strings(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => text(x)).filter((x): x is string => !!x).slice(0, 20);
  const one = text(v);
  return one ? [one] : [];
}

function categoryOf(sourceType: string | null): AmlCategory {
  const s = (sourceType ?? '').toLowerCase();
  if (s.includes('sanction')) return 'SANCTIONS';
  if (s.includes('pep')) return 'PEP';
  if (s.includes('adverse') || s.includes('media')) return 'ADVERSE_MEDIA';
  if (s.includes('warning') || s.includes('watch')) return 'WARNING';
  return 'UNKNOWN';
}

const STRENGTH: AmlCategory[] = ['SANCTIONS', 'PEP', 'ADVERSE_MEDIA', 'WARNING', 'UNKNOWN'];

function toMatch(r: Record<string, unknown>): AmlMatch {
  const articles = Array.isArray(r.articles)
    ? r.articles
        .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
        .map((a) => ({ title: text(a.title) ?? '', url: text(a.url, 500) ?? '' }))
        .filter((a) => a.title || a.url)
        .slice(0, 10)
    : [];
  const score = typeof r.score === 'number' && Number.isFinite(r.score) ? r.score : null;
  return {
    name: text(r.name),
    aliases: strings(r.aliases),
    dateOfBirth: text(r.date_of_birth, 20),
    country: text(r.country ?? r.countryName, 80),
    positions: strings(r.positions),
    sourceType: text(r.source_type ?? r.entryCategory, 80),
    score,
    articles,
  };
}

/**
 * Principles 3 and 4. `results` may be an object, an array, empty or missing.
 * CLEAR only for exactly "No Match" (trimmed, any case) with no results.
 */
export function parseAmlResult(body: unknown): AmlParsed {
  const e = entityOf(body);
  const rawStatus = typeof e?.match_status === 'string' ? e.match_status.trim() : null;
  const matchStatus = rawStatus ? rawStatus.slice(0, 64) : null;
  const riskLevel = text(e?.risk_level, 64);
  const entityId = text(e?.entity_id, 100);

  const raw = e?.results;
  const list: Record<string, unknown>[] = Array.isArray(raw)
    ? raw.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    : raw && typeof raw === 'object'
      ? [raw as Record<string, unknown>]
      : [];
  const matches = list.slice(0, MAX_MATCHES).map(toMatch);
  const cats = matches.map((m) => categoryOf(m.sourceType));
  const category = matches.length ? (STRENGTH.find((c) => cats.includes(c)) ?? 'UNKNOWN') : null;

  const s = (rawStatus ?? '').toLowerCase();
  let status: AmlParsed['status'];
  if (s === 'no match' && matches.length === 0) status = 'CLEAR';
  else if (s === 'confirmed match') status = 'CONFIRMED_MATCH';
  else if (s === 'potential match' || s === 'possible match' || (s === 'no match' && matches.length > 0)) status = 'POSSIBLE_MATCH';
  else status = 'UNKNOWN';

  return { status, matchStatus, riskLevel, entityId, category, matches };
}
