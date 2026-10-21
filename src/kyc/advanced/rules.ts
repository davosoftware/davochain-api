import { matchIdentity } from '../name-match';
import { addressInText, latestDate, nameInText, toIsoDate, withinMonths } from './text-finders';
import type {
  AddressEvidence,
  AddressKindName,
  AdvancedIdTypeName,
  BillRead,
  Decision,
  IdRead,
  LivenessRead,
  MatchRead,
  RejectCode,
  ReviewReason,
  Thresholds,
  Verified,
} from './advanced.types';

const TYPE_WORDS: Record<AdvancedIdTypeName, RegExp> = {
  // Whole words: "International Passport" must not read as a national ID.
  NATIONAL_ID: /\bnational\b|\bidentity\b|\bnin\b|\bid card\b/i,
  PASSPORT: /passport/i,
  DRIVERS_LICENSE: /driv/i,
};
/** Under this many characters, the text reader found too little to judge. */
const SPARSE_TEXT = 40;

function verdict(reject: RejectCode | null, reasons: ReviewReason[]): Decision {
  if (reject) return { outcome: 'REJECT', code: reject, reasons };
  return reasons.length ? { outcome: 'REVIEW', reasons } : { outcome: 'APPROVE', reasons: [] };
}

/**
 * Spec §7.1. Liveness and match may be absent (the runner asks after the read
 * alone, to stop before paying for more); without both, nothing is approved.
 * A reject wins over review reasons and keeps them, so the record says everything found.
 */
export function decideIdentity(i: {
  idType: AdvancedIdTypeName;
  read: IdRead;
  liveness?: LivenessRead;
  match?: MatchRead;
  noPortrait?: boolean;
  duplicate?: boolean;
  verified: Verified;
  t: Thresholds;
  today: string;
}): Decision {
  const { read, verified, t } = i;
  const reasons: ReviewReason[] = [];
  let reject: RejectCode | null = null;
  const fail = (code: RejectCode) => {
    reject ??= code;
  };

  if (!read.valid) fail('ID_UNREADABLE');

  if (!read.firstName || !read.lastName) {
    if (read.unreadable.includes('name')) reasons.push('ID_FIELD_UNREADABLE');
    else fail('ID_UNREADABLE');
  }
  if (!read.dateOfBirth) {
    if (read.unreadable.includes('dateOfBirth')) reasons.push('DOB_UNREADABLE');
    else fail('ID_UNREADABLE');
  } else if (read.dateOfBirth !== verified.dateOfBirth) {
    fail('DETAILS_MISMATCH');
  }

  if (read.firstName && read.lastName) {
    // Basic's own matching rules (exact after cleanup, first/last may swap). DOB is judged above.
    const m = matchIdentity(
      { firstName: verified.firstName, middleName: verified.middleName, lastName: verified.lastName, dateOfBirth: verified.dateOfBirth },
      { usable: true, firstName: read.firstName, middleName: read.middleName, lastName: read.lastName, dateOfBirth: verified.dateOfBirth, gender: 'UNKNOWN', customerRef: null },
    );
    if (!m.matched) reasons.push('NAME_DIFFERS');
  }

  if (read.expiry === null) reasons.push('NO_EXPIRY');
  else if (read.expiry < i.today) fail('ID_EXPIRED');

  if (read.documentName && !TYPE_WORDS[i.idType].test(read.documentName)) reasons.push('ID_TYPE_DIFFERS');

  if (i.liveness) {
    const l = i.liveness;
    if (!l.faceDetected || l.multiFace || !l.live) fail('SELFIE_NOT_LIVE');
    else if (l.probability === null || l.probability < t.livenessMin) reasons.push('LIVENESS_LOW');
  }

  if (i.noPortrait) reasons.push('NO_ID_PHOTO');
  else if (i.match) {
    const c = i.match.confidence;
    if (c === null) reasons.push('FACE_MATCH_BORDERLINE');
    else if (c < t.faceMatchReview) fail('FACE_MISMATCH');
    else if (c < t.faceMatchPass) reasons.push('FACE_MATCH_BORDERLINE');
  }

  if (i.duplicate) reasons.push('DUPLICATE_ID');

  const decided = verdict(reject, reasons);
  // Without both face checks recorded, a clean read is not yet an approval.
  if (decided.outcome === 'APPROVE' && (!i.liveness || (!i.match && !i.noPortrait))) return { outcome: 'REVIEW', reasons: [] };
  return decided;
}

export function summariseBill(b: BillRead, verified: Verified): AddressEvidence {
  const text = [b.fullName, b.street, b.city, b.state].filter(Boolean).join(' ');
  return {
    source: 'BILL',
    // Dojah structured it, so "too little text" doesn't apply; 0 marks a bill Dojah could not read.
    textLength: b.ok ? Math.max(text.length, SPARSE_TEXT) : 0,
    name: b.fullName ? nameInText(b.fullName, verified) : 'NONE',
    date: toIsoDate(b.issueDate),
    address: addressInText([b.street, b.city, b.state].filter(Boolean).join(', '), verified.address),
    provider: b.provider,
  };
}

/** Everything the decision needs from the text, so the text itself is never stored (spec §5.2). */
export function summariseText(lines: string[], kind: AddressKindName, verified: Verified, today: string): AddressEvidence {
  const text = lines.join('\n');
  return {
    source: 'TEXT',
    textLength: text.trim().length,
    name: nameInText(text, verified),
    date: latestDate(text, today, { allowFuture: kind === 'TENANCY' }),
    address: addressInText(text, verified.address),
  };
}

/** Spec §7.2. A tenancy agreement must still be running; anything else must be recent. */
export function decideAddress(i: { kind: AddressKindName; pdf: boolean; evidence?: AddressEvidence; recencyMonths: number; today: string }): Decision {
  if (i.pdf || !i.evidence) return { outcome: 'REVIEW', reasons: ['PDF'] };
  const e = i.evidence;
  // Dojah answered but couldn't read the bill: a person looks (only a 424 is a reject, spec §7.2).
  if (e.source === 'BILL' && e.textLength === 0) return { outcome: 'REVIEW', reasons: ['TEXT_SPARSE'] };

  const reasons: ReviewReason[] = [];
  let reject: RejectCode | null = null;
  if (e.textLength < SPARSE_TEXT) reasons.push('TEXT_SPARSE');
  if (e.name !== 'FULL') reasons.push('NAME_NOT_FOUND');

  if (i.kind === 'TENANCY') {
    if (!e.date) reasons.push('NO_END_DATE');
    else if (e.date < i.today) reject = 'DOC_TOO_OLD';
  } else if (!e.date) reasons.push('NO_DATE');
  else if (!withinMonths(e.date, i.today, i.recencyMonths)) reject = 'DOC_TOO_OLD';

  if (e.address === 'PARTIAL') reasons.push('ADDRESS_PARTIAL');
  else if (e.address === 'NONE') reasons.push('ADDRESS_NOT_FOUND');
  return verdict(reject, reasons);
}
