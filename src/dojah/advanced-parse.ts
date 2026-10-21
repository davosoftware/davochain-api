import type { BillRead, IdRead, LivenessRead, MatchRead } from '../kyc/advanced/advanced.types';
import { toIsoDate } from '../kyc/advanced/text-finders';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null;

/**
 * Dojah documents only "dob" as a field_key. These aliases are our best reading
 * of the rest; the sandbox check (scripts/check-dojah-advanced.ts) prints the real
 * keys, and this table is the one place to correct them.
 */
const KEYS: Record<'first' | 'middle' | 'last' | 'full' | 'dob' | 'expiry' | 'number', string[]> = {
  first: ['first_name', 'firstname', 'given_name', 'given_names'],
  middle: ['middle_name', 'middlename'],
  last: ['last_name', 'lastname', 'surname'],
  full: ['full_name', 'fullname', 'name'],
  dob: ['dob', 'date_of_birth', 'birth_date'],
  expiry: ['expiry_date', 'date_of_expiry', 'expiry', 'exp_date', 'expiration_date'],
  number: ['document_number', 'doc_number', 'id_number', 'passport_number', 'license_number', 'licence_number', 'nin'],
};

/** Dojah's document analysis → what the rules read. The portrait is returned apart, to be used once and dropped. */
export function parseIdAnalysis(body: unknown): { read: IdRead; portrait: string | null } {
  const e = obj(obj(body).entity);
  const status = obj(e.status);
  const fields = new Map<string, { status: number; value: string | null }>();
  for (const raw of Array.isArray(e.text_data) ? e.text_data : []) {
    const f = obj(raw);
    const key = str(f.field_key)?.toLowerCase();
    if (key) fields.set(key, { status: num(f.status) ?? 0, value: str(f.value) });
  }
  const pick = (k: keyof typeof KEYS) => {
    for (const key of KEYS[k]) {
      const f = fields.get(key);
      if (f) return f;
    }
    return null;
  };
  const value = (k: keyof typeof KEYS) => {
    const f = pick(k);
    return f && f.status === 1 ? f.value : null;
  };
  const unreadable = (k: keyof typeof KEYS) => pick(k)?.status === 2;

  let firstName = value('first');
  let middleName = value('middle');
  let lastName = value('last');
  const full = value('full');
  if ((!firstName || !lastName) && full) {
    const parts = full.split(/\s+/);
    if (parts.length >= 2) {
      lastName ??= parts[parts.length - 1];
      firstName ??= parts[0];
      middleName ??= parts.length > 2 ? parts.slice(1, -1).join(' ') : null;
    }
  }
  const out: IdRead['unreadable'] = [];
  if ((!firstName || !lastName) && (unreadable('first') || unreadable('last') || unreadable('full'))) out.push('name');
  // Read by Dojah but in a form we can't parse (e.g. "12 MAR /MARS 85"): a person decides, never a reject.
  const dateOfBirth = toIsoDate(value('dob'));
  const expiry = toIsoDate(value('expiry'));
  if (unreadable('dob') || (value('dob') && !dateOfBirth)) out.push('dateOfBirth');
  if (unreadable('expiry') || (value('expiry') && !expiry)) out.push('expiry');
  if (unreadable('number')) out.push('documentNumber');

  return {
    read: {
      valid: num(status.overall_status) === 1,
      documentName: str(obj(e.document_type).document_name),
      firstName,
      middleName,
      lastName,
      dateOfBirth,
      expiry,
      documentNumber: value('number'),
      unreadable: out,
    },
    portrait: str(obj(e.document_images).portrait),
  };
}

export function parseLiveness(body: unknown): LivenessRead {
  const e = obj(obj(body).entity);
  const l = obj(e.liveness);
  const f = obj(e.face);
  return { live: l.liveness_check === true, probability: num(l.liveness_probability), faceDetected: f.face_detected === true, multiFace: f.multiface_detected === true };
}

export function parseMatch(body: unknown): MatchRead {
  return { confidence: num(obj(obj(obj(body).entity).selfie).confidence_value) };
}

export function parseBill(body: unknown): BillRead {
  const e = obj(obj(body).entity);
  const a = obj(e.address_info);
  const recent = obj(e.metadata).is_recent;
  return {
    ok: str(obj(e.result).status)?.toLowerCase() === 'success',
    fullName: str(obj(e.identity_info).full_name),
    street: str(a.street),
    city: str(a.city),
    state: str(a.state),
    issueDate: str(e.bill_issue_date),
    isRecent: typeof recent === 'boolean' ? recent : null,
    provider: str(e.provider_name),
  };
}

export function parseOcr(body: unknown): string[] {
  const data = obj(obj(body).entity).data;
  return Array.isArray(data) ? data.filter((x): x is string => typeof x === 'string') : [];
}
