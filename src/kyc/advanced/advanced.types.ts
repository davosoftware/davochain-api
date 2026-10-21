/** Advanced verification: the shared words (spec 2026-10-21). */
export type AdvancedIdTypeName = 'NATIONAL_ID' | 'PASSPORT' | 'DRIVERS_LICENSE';
export type AddressKindName = 'UTILITY_BILL' | 'BANK_STATEMENT' | 'GOVERNMENT_LETTER' | 'TENANCY';

export type RejectCode =
  | 'ID_UNREADABLE'
  | 'ID_EXPIRED'
  | 'DETAILS_MISMATCH'
  | 'SELFIE_NOT_LIVE'
  | 'FACE_MISMATCH'
  | 'DOC_UNREADABLE'
  | 'DOC_TOO_OLD'
  | 'BY_REVIEW';

/** Why an attempt went to a person. Shown to admins in plain words (dashboard lib/advanced.ts). */
export type ReviewReason =
  | 'ID_TYPE_DIFFERS'
  | 'ID_FIELD_UNREADABLE'
  | 'NAME_DIFFERS'
  | 'DOB_UNREADABLE'
  | 'NO_EXPIRY'
  | 'LIVENESS_LOW'
  | 'FACE_MATCH_BORDERLINE'
  | 'NO_ID_PHOTO'
  | 'DUPLICATE_ID'
  | 'TEXT_SPARSE'
  | 'NAME_NOT_FOUND'
  | 'NO_DATE'
  | 'NO_END_DATE'
  | 'ADDRESS_PARTIAL'
  | 'ADDRESS_NOT_FOUND'
  | 'PDF'
  | 'SYSTEM';

export interface IdRead {
  valid: boolean;
  documentName: string | null;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  /** YYYY-MM-DD */
  dateOfBirth: string | null;
  /** YYYY-MM-DD */
  expiry: string | null;
  /** In memory only: stored as a hash plus last 4 (spec §5.2). */
  documentNumber: string | null;
  /** Fields Dojah marked present-but-unreadable (status 2). */
  unreadable: ('name' | 'dateOfBirth' | 'expiry' | 'documentNumber')[];
}
export interface LivenessRead {
  live: boolean;
  probability: number | null;
  faceDetected: boolean;
  multiFace: boolean;
}
export interface MatchRead {
  confidence: number | null;
}
export interface BillRead {
  ok: boolean;
  fullName: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  issueDate: string | null;
  isRecent: boolean | null;
  provider: string | null;
}

/** The verified Basic record and the address typed at Basic: what Advanced is compared with. */
export interface Verified {
  firstName: string;
  middleName: string | null;
  lastName: string;
  dateOfBirth: string;
  address: { street: string | null; city: string | null; state: string | null };
}
export interface Thresholds {
  livenessMin: number;
  faceMatchPass: number;
  faceMatchReview: number;
}

/** Everything the address decision needs, so the document's text is never stored (spec §5.2). */
export interface AddressEvidence {
  source: 'BILL' | 'TEXT';
  textLength: number;
  name: 'FULL' | 'PARTIAL' | 'NONE';
  /** Issue date; for a tenancy agreement, the latest date (read as the end date). */
  date: string | null;
  address: 'MATCH' | 'PARTIAL' | 'NONE';
  provider?: string | null;
}

export type Decision =
  | { outcome: 'APPROVE'; reasons: [] }
  | { outcome: 'REVIEW'; reasons: ReviewReason[] }
  | { outcome: 'REJECT'; code: RejectCode; reasons: ReviewReason[] };

/** Spec §7.4, verbatim. */
export const REJECT_MESSAGES: Record<Exclude<RejectCode, 'BY_REVIEW' | 'DOC_TOO_OLD'>, string> = {
  ID_UNREADABLE: "We couldn't read your ID. Take a clear, well-lit photo of the whole card, with no glare.",
  ID_EXPIRED: "This ID has expired. Please use one that's still valid.",
  DETAILS_MISMATCH: "The date of birth on this ID doesn't match your verified details.",
  SELFIE_NOT_LIVE: "We couldn't confirm a live selfie. Take a new selfie in good light, facing the camera, with only you in the picture.",
  FACE_MISMATCH: "Your selfie doesn't match the photo on your ID. Try again with a clear selfie.",
  DOC_UNREADABLE: "We couldn't read this document. Send a clear photo of the whole page.",
};
export const tooOldMessage = (months: number) =>
  `This document is too old. Please send one issued in the last ${months} months (or a tenancy agreement that's still running).`;
export const MSG_IN_REVIEW = "We're checking your documents. This usually takes less than a day.";
export const MSG_FAILED_SYSTEM = "We couldn't finish the check. Please try again later. This didn't use one of your attempts.";
