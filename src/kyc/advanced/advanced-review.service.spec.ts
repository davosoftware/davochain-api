import { AdvancedApprover } from './advanced-approver';
import { AdvancedReviewService, REVIEW_REJECT_MESSAGES } from './advanced-review.service';
import { fakeDb } from './advanced.test-db';

function build(state = 'IN_REVIEW', step = 'IDENTITY', over: Record<string, unknown> = {}) {
  const db = fakeDb({
    advancedVerification: [
      {
        id: 'v1', userId: 'u1', step, state, activeFor: 'u1', frontDocumentId: 'f', backDocumentId: null, selfieDocumentId: 's', addressDocumentId: null,
        idType: 'NATIONAL_ID', addressKind: null, findings: { id: { firstName: 'SOMEONE', documentNumber: null } }, reviewReasons: ['FACE_MATCH_BORDERLINE'],
        docLast4: '5678', createdAt: new Date(), updatedAt: new Date(), ...over,
      },
    ],
    kycDocument: [
      { id: 'f', type: 'NATIONAL_ID', mimeType: 'image/png', status: 'PENDING' },
      { id: 's', type: 'SELFIE', mimeType: 'image/jpeg', status: 'PENDING' },
    ],
    user: [{ id: 'u1', firstName: 'Someone', lastName: 'Clean', email: 'u1@x.test', kycTier: step === 'IDENTITY' ? 'TIER_1' : 'TIER_2', kycStatus: 'APPROVED' }],
    kycProfile: [{ userId: 'u1', tier: step === 'IDENTITY' ? 'TIER_1' : 'TIER_2', status: 'APPROVED' }],
    refreshToken: [{ userId: 'u1', revokedAt: null }],
  });
  const mail = { send: jest.fn(async () => undefined) };
  const approver = new AdvancedApprover(db as never, mail as never, { onKycChanged: jest.fn(async () => undefined) } as never);
  const verified = { firstName: 'Someone', middleName: null, lastName: 'Clean', dateOfBirth: '1995-03-03', address: { street: '1 E2E Street', city: 'Ikeja', state: 'Lagos' } };
  const runner = { verified: jest.fn(async () => verified) };
  const svc = new AdvancedReviewService(db as never, approver, runner as never);
  return { svc, db, mail, row: () => db.advancedVerification.rows[0] as Record<string, unknown>, user: db.user.rows[0] as Record<string, unknown> };
}

describe('AdvancedReviewService.decide (spec 2026-10-21 §8)', () => {
  it('approves an IN_REVIEW identity attempt to TIER_2, audited', async () => {
    const h = build();
    expect(await h.svc.decide({ adminId: 'a1', ip: '1.2.3.4' }, 'v1', { approve: true, reason: 'APPROVED_AFTER_REVIEW' })).toEqual({ state: 'APPROVED' });
    expect(h.user.kycTier).toBe('TIER_2');
    expect(h.row()).toMatchObject({ state: 'APPROVED', activeFor: null, reviewedBy: 'a1', reviewNote: null });
    expect(h.db.adminAuditLog.rows).toEqual([
      expect.objectContaining({ adminUserId: 'a1', action: 'kyc.advanced.approve', entity: 'AdvancedVerification', entityId: 'v1', ip: '1.2.3.4' }),
    ]);
  });

  it('approves an address attempt to TIER_3', async () => {
    const h = build('IN_REVIEW', 'ADDRESS');
    await h.svc.decide({ adminId: 'a1' }, 'v1', { approve: true, reason: 'APPROVED_AFTER_REVIEW' });
    expect(h.user.kycTier).toBe('TIER_3');
  });

  it('rejects with the customer wording for the chosen reason; the level is untouched', async () => {
    const h = build();
    expect(await h.svc.decide({ adminId: 'a1' }, 'v1', { approve: false, reason: 'DOC_ALTERED' })).toEqual({ state: 'REJECTED' });
    expect(h.row()).toMatchObject({ state: 'REJECTED', rejectCode: 'BY_REVIEW', customerMessage: REVIEW_REJECT_MESSAGES.DOC_ALTERED, activeFor: null });
    expect(h.user.kycTier).toBe('TIER_1');
    expect(h.db.adminAuditLog.rows[0]).toMatchObject({ action: 'kyc.advanced.reject' });
  });

  it('OTHER needs a note, and the note is what the customer sees', async () => {
    const h = build();
    await expect(h.svc.decide({ adminId: 'a1' }, 'v1', { approve: false, reason: 'OTHER' })).rejects.toThrow('Write the note the customer will see.');
    await h.svc.decide({ adminId: 'a1' }, 'v1', { approve: false, reason: 'OTHER', note: '  Please send the full page.  ' });
    expect(h.row()).toMatchObject({ customerMessage: 'Please send the full page.', reviewNote: 'Please send the full page.' });
  });

  it('404 when nothing is waiting (still CHECKING, or already decided); nothing audited', async () => {
    for (const state of ['CHECKING', 'APPROVED', 'REJECTED']) {
      const h = build(state);
      await expect(h.svc.decide({ adminId: 'a1' }, 'v1', { approve: true, reason: 'APPROVED_AFTER_REVIEW' })).rejects.toThrow('Nothing is waiting for review with this id');
      expect(h.db.adminAuditLog.rows).toHaveLength(0);
    }
  });

  it('a decision and a reason that disagree are refused', async () => {
    const h = build();
    await expect(h.svc.decide({ adminId: 'a1' }, 'v1', { approve: true, reason: 'DOC_ALTERED' })).rejects.toThrow('To approve, choose "Approved after review".');
    await expect(h.svc.decide({ adminId: 'a1' }, 'v1', { approve: false, reason: 'APPROVED_AFTER_REVIEW' })).rejects.toThrow('Choose why it is rejected.');
  });
});

describe('AdvancedReviewService.list', () => {
  it('shows the evidence beside the verified record, never a full number', async () => {
    const h = build();
    const r = await h.svc.list();
    expect(r).toMatchObject({ waiting: 1, approvedToday: 0, rejectedToday: 0 });
    expect(r.rows[0]).toMatchObject({
      id: 'v1',
      step: 'IDENTITY',
      user: { id: 'u1', firstName: 'Someone', email: 'u1@x.test' },
      verified: { firstName: 'Someone', dateOfBirth: '1995-03-03' },
      docLast4: '5678',
      reviewReasons: ['FACE_MATCH_BORDERLINE'],
      documents: [
        { id: 'f', type: 'NATIONAL_ID', mimeType: 'image/png' },
        { id: 's', type: 'SELFIE', mimeType: 'image/jpeg' },
      ],
    });
  });
  it('counts today\'s decisions', async () => {
    const h = build('APPROVED');
    expect(await h.svc.list()).toMatchObject({ waiting: 0, approvedToday: 1, rows: [] });
  });
});
