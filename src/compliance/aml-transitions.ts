import type { AmlCaseStatus, AmlScreeningStatus, AmlStatus, KycVerificationState } from '@prisma/client';

/** Spec §7, as amended by plan rulings 2 and 5. Nothing else moves. */
export const VERIFICATION_TRANSITIONS: Record<KycVerificationState, readonly KycVerificationState[]> = {
  CREATED: ['LOOKED_UP', 'REJECTED_NOT_FOUND', 'FAILED_SYSTEM'],
  LOOKED_UP: ['APPROVED', 'IDENTITY_REVIEW', 'COMPLIANCE_REVIEW'],
  IDENTITY_REVIEW: ['APPROVED', 'COMPLIANCE_REVIEW', 'REJECTED_BY_REVIEW'],
  COMPLIANCE_REVIEW: ['APPROVED'],
  APPROVED: [],
  REJECTED_NOT_FOUND: [],
  REJECTED_BY_REVIEW: [],
  FAILED_SYSTEM: [],
};

export const TERMINAL_VERIFICATION: ReadonlySet<KycVerificationState> = new Set<KycVerificationState>([
  'APPROVED',
  'REJECTED_NOT_FOUND',
  'REJECTED_BY_REVIEW',
  'FAILED_SYSTEM',
]);

export const SCREENING_TRANSITIONS: Record<AmlScreeningStatus, readonly AmlScreeningStatus[]> = {
  PENDING: ['CLEAR', 'POSSIBLE_MATCH', 'CONFIRMED_MATCH', 'UNKNOWN', 'ERROR'],
  ERROR: ['PENDING'], // a manual re-screen re-arms it (plan ruling 5)
  CLEAR: [],
  POSSIBLE_MATCH: [],
  CONFIRMED_MATCH: [],
  UNKNOWN: [],
};

export const CASE_TRANSITIONS: Record<AmlCaseStatus, readonly AmlCaseStatus[]> = {
  OPEN: ['CLEARED', 'PEP_APPROVED_EDD', 'RESTRICTED', 'SANCTIONS_CONFIRMED', 'CLEARANCE_PROPOSED'],
  CLEARANCE_PROPOSED: ['SANCTIONS_FALSE_POSITIVE', 'OPEN'],
  RESTRICTED: ['CLEARED'],
  CLEARED: [],
  PEP_APPROVED_EDD: [],
  SANCTIONS_CONFIRMED: [],
  SANCTIONS_FALSE_POSITIVE: [],
};

export const AML_STATUS_TRANSITIONS: Record<AmlStatus, readonly AmlStatus[]> = {
  NOT_SCREENED: ['PENDING'],
  CLEAR: ['PENDING'],
  PENDING: ['CLEAR', 'UNDER_REVIEW', 'BLOCKED'],
  UNDER_REVIEW: ['CLEAR', 'RESTRICTED', 'BLOCKED'],
  RESTRICTED: ['CLEAR', 'BLOCKED'],
  BLOCKED: ['CLEAR'],
};

export function allowed<S extends string>(table: Record<S, readonly S[]>, from: S | string, to: S | string): boolean {
  return (table as Record<string, readonly string[]>)[from]?.includes(to) ?? false;
}
