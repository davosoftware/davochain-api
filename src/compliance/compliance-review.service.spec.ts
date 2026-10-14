import { FakePrisma } from '../ngn-deposits/testing/fake-prisma';
import { ComplianceReviewService } from './compliance-review.service';

const OWNER_A = { adminId: 'oa', role: 'OWNER' as const, permissions: [], ip: '203.0.113.1' };
const OWNER_B = { adminId: 'ob', role: 'OWNER' as const, permissions: [] };
const SUB = { adminId: 'sa', role: 'SUB_ADMIN' as const, permissions: ['compliance.view', 'compliance.review'] };

async function setup(opts: { category?: string; status?: string; amlStatus?: string; owners?: string[]; subs?: string[] } = {}) {
  const db = new FakePrisma();
  for (const id of opts.owners ?? ['oa', 'ob']) await db.adminUser.create({ data: { id, email: `${id}@x.test`, name: id, role: 'OWNER', isActive: true, permissions: [] } });
  for (const id of opts.subs ?? ['sa']) await db.adminUser.create({ data: { id, email: `${id}@x.test`, name: id, role: 'SUB_ADMIN', isActive: true, permissions: ['compliance.view', 'compliance.review'] } });
  await db.user.create({ data: { id: 'u1', email: 'u@x.test', firstName: 'A', lastName: 'B', amlStatus: opts.amlStatus ?? 'BLOCKED' } });
  await db.amlScreening.create({ data: { id: 's1', userId: 'u1', inputs: { names: 'A B' }, inputFingerprint: 'f', status: opts.category === 'ERROR' ? 'ERROR' : 'CONFIRMED_MATCH', category: opts.category ?? 'SANCTIONS', sendCount: 2, unknownCount: 2 } });
  await db.kycVerification.create({ data: { id: 'v1', userId: 'u1', activeFor: 'u1', state: 'COMPLIANCE_REVIEW', lagosDay: '2026-10-14', idType: 'BVN', idHash: 'h1:x', idLast4: '2222', typedFirstName: 'A', typedLastName: 'B', typedDateOfBirth: '2000-01-01', typedAddress: {}, screeningId: 's1' } });
  await db.amlReviewCase.create({ data: { id: 'c1', userId: 'u1', screeningId: 's1', category: opts.category ?? 'SANCTIONS', priority: 'CRITICAL', status: opts.status ?? 'OPEN' } });
  const basic = {
    approve: jest.fn(async (_tx: unknown, id: string) => {
      await db.kycVerification.updateMany({ where: { id }, data: { state: 'APPROVED', activeFor: null } });
      return [];
    }),
  };
  const aml = {
    send: jest.fn(async (..._a: unknown[]) => undefined),
    setAmlStatus: jest.fn(async (_tx: unknown, userId: string, to: string, from: string[]) => (await db.user.updateMany({ where: { id: userId, amlStatus: { in: from } }, data: { amlStatus: to } })).count === 1),
  };
  const va = { setDesiredForUser: jest.fn(async (..._a: unknown[]) => undefined) };
  const alerts = { raise: jest.fn(async (..._a: unknown[]) => true) };
  return { db, basic, aml, va, alerts, svc: new ComplianceReviewService(db as never, basic as never, aml as never, va as never, alerts as never) };
}

describe('ComplianceReviewService: sanctions and the two-person rule (spec §14.1)', () => {
  it('a sub-admin cannot decide a sanctions case', async () => {
    const { svc } = await setup();
    await expect(svc.decide(SUB, 'c1', { decision: 'SANCTIONS_CONFIRMED', reason: 'Matches the list entry', reportedToAuthority: false })).rejects.toMatchObject({ status: 403 });
  });

  it('only sanctions decisions are allowed on a sanctions case', async () => {
    const { svc } = await setup();
    await expect(svc.decide(OWNER_A, 'c1', { decision: 'CLEARED', reason: 'a long enough reason' })).rejects.toMatchObject({ status: 400 });
  });

  it('sanctions decisions are refused on other cases', async () => {
    const { svc } = await setup({ category: 'PEP', amlStatus: 'UNDER_REVIEW' });
    await expect(svc.decide(OWNER_A, 'c1', { decision: 'SANCTIONS_FALSE_POSITIVE', reason: 'a long enough reason' })).rejects.toMatchObject({ status: 400 });
  });

  it('SANCTIONS_CONFIRMED needs the report fields, keeps BLOCKED and is audited', async () => {
    const { svc, db } = await setup();
    await expect(svc.decide(OWNER_A, 'c1', { decision: 'SANCTIONS_CONFIRMED', reason: 'Matches the list entry' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.decide(OWNER_A, 'c1', { decision: 'SANCTIONS_CONFIRMED', reason: 'Matches the list entry', reportedToAuthority: true })).rejects.toMatchObject({ status: 400 });
    expect((await svc.decide(OWNER_A, 'c1', { decision: 'SANCTIONS_CONFIRMED', reason: 'Matches the list entry', reportedToAuthority: true, reportReference: 'NFIU-123', reportedAt: '2026-10-14T10:00:00Z' })).status).toBe('SANCTIONS_CONFIRMED');
    expect(db.rows('user')[0].amlStatus).toBe('BLOCKED');
    expect(db.rows('amlReviewCase')[0]).toMatchObject({ decidedBy: 'oa', reportReference: 'NFIU-123', reportedToAuthority: true });
    expect(db.rows('adminAuditLog').map((r) => r.action)).toContain('aml.case.decide');
  });

  it('confirming a POSSIBLE sanctions match blocks the user and revokes sessions', async () => {
    const { svc, db, va } = await setup({ amlStatus: 'UNDER_REVIEW' });
    await db.refreshToken.create({ data: { userId: 'u1', revokedAt: null } });
    await svc.decide(OWNER_A, 'c1', { decision: 'SANCTIONS_CONFIRMED', reason: 'Matches the list entry', reportedToAuthority: false });
    expect(db.rows('user')[0].amlStatus).toBe('BLOCKED');
    expect(db.rows('refreshToken')[0].revokedAt).toBeInstanceOf(Date);
    expect(va.setDesiredForUser).toHaveBeenCalledWith('u1', 'INACTIVE', { background: true });
  });

  it('a false positive is only a proposal: the user stays BLOCKED', async () => {
    const { svc, db, alerts } = await setup();
    expect((await svc.decide(OWNER_A, 'c1', { decision: 'SANCTIONS_FALSE_POSITIVE', reason: 'Different date of birth' })).status).toBe('CLEARANCE_PROPOSED');
    expect(db.rows('user')[0].amlStatus).toBe('BLOCKED');
    expect(db.rows('amlReviewCase')[0]).toMatchObject({ proposedBy: 'oa', proposalReason: 'Different date of birth' });
    expect(alerts.raise).toHaveBeenCalledWith('AML_SANCTIONS', 'case:c1:proposed', expect.any(String), expect.any(Array), 0);
    expect(db.rows('adminAuditLog').map((r) => r.action)).toContain('aml.case.propose_clearance');
  });

  it('the proposer can never confirm their own proposal', async () => {
    const { svc, db } = await setup({ status: 'CLEARANCE_PROPOSED' });
    await db.amlReviewCase.updateMany({ where: { id: 'c1' }, data: { proposedBy: 'oa' } });
    await expect(svc.confirm(OWNER_A, 'c1', { confirm: true, reason: 'I agree with myself' })).rejects.toMatchObject({ status: 403 });
    expect(db.rows('user')[0].amlStatus).toBe('BLOCKED');
  });

  it('a second owner confirms: SANCTIONS_FALSE_POSITIVE, user CLEAR, verification approved, deposit account back on', async () => {
    const { svc, db, va, basic } = await setup({ status: 'CLEARANCE_PROPOSED' });
    await db.amlReviewCase.updateMany({ where: { id: 'c1' }, data: { proposedBy: 'oa' } });
    expect((await svc.confirm(OWNER_B, 'c1', { confirm: true, reason: 'Checked the DOB myself' })).status).toBe('SANCTIONS_FALSE_POSITIVE');
    expect(db.rows('user')[0].amlStatus).toBe('CLEAR');
    expect(db.rows('amlReviewCase')[0]).toMatchObject({ confirmedBy: 'ob', decidedBy: 'ob' });
    expect(basic.approve).toHaveBeenCalledWith(expect.anything(), 'v1');
    expect(va.setDesiredForUser).toHaveBeenCalledWith('u1', 'ACTIVE', { background: true });
    expect(db.rows('adminAuditLog').map((r) => r.action)).toContain('aml.case.confirm');
  });

  it('a sub-admin may confirm only when no other active owner exists', async () => {
    const two = await setup({ status: 'CLEARANCE_PROPOSED' });
    await two.db.amlReviewCase.updateMany({ where: { id: 'c1' }, data: { proposedBy: 'oa' } });
    await expect(two.svc.confirm(SUB, 'c1', { confirm: true, reason: 'Checked it myself' })).rejects.toMatchObject({ status: 403 });

    const one = await setup({ status: 'CLEARANCE_PROPOSED', owners: ['oa'] });
    await one.db.amlReviewCase.updateMany({ where: { id: 'c1' }, data: { proposedBy: 'oa' } });
    expect((await one.svc.confirm(SUB, 'c1', { confirm: true, reason: 'Checked it myself' })).status).toBe('SANCTIONS_FALSE_POSITIVE');
  });

  it('an inactive second owner does not count, so a compliance sub-admin may confirm', async () => {
    const { svc, db } = await setup({ status: 'CLEARANCE_PROPOSED' });
    await db.adminUser.updateMany({ where: { id: 'ob' }, data: { isActive: false } });
    await db.amlReviewCase.updateMany({ where: { id: 'c1' }, data: { proposedBy: 'oa' } });
    expect((await svc.confirm(SUB, 'c1', { confirm: true, reason: 'Checked it myself' })).status).toBe('SANCTIONS_FALSE_POSITIVE');
  });

  it('with nobody else eligible the proposal waits and the detail says why', async () => {
    const { svc, db } = await setup({ status: 'CLEARANCE_PROPOSED', owners: ['oa'], subs: [] });
    await db.amlReviewCase.updateMany({ where: { id: 'c1' }, data: { proposedBy: 'oa' } });
    expect(await svc.confirmEligibility(OWNER_A, 'oa')).toEqual({ canConfirm: false, why: expect.stringMatching(/different admin/i) });
    expect((await svc.detail(OWNER_A, 'c1')).eligibility.why).toMatch(/grant compliance\.review to a second trusted admin/i);
  });

  it('the confirmer may reject: back to OPEN, proposal cleared, audited', async () => {
    const { svc, db } = await setup({ status: 'CLEARANCE_PROPOSED' });
    await db.amlReviewCase.updateMany({ where: { id: 'c1' }, data: { proposedBy: 'oa', proposalReason: 'x' } });
    expect((await svc.confirm(OWNER_B, 'c1', { confirm: false, reason: 'Not convinced yet' })).status).toBe('OPEN');
    expect(db.rows('amlReviewCase')[0]).toMatchObject({ proposedBy: null, proposalReason: null });
    expect(db.rows('user')[0].amlStatus).toBe('BLOCKED');
    expect(db.rows('adminAuditLog').map((r) => r.action)).toContain('aml.case.reject_proposal');
  });

  it('only the proposer may withdraw', async () => {
    const { svc, db } = await setup({ status: 'CLEARANCE_PROPOSED' });
    await db.amlReviewCase.updateMany({ where: { id: 'c1' }, data: { proposedBy: 'oa' } });
    await expect(svc.withdraw(OWNER_B, 'c1', 'not mine to withdraw')).rejects.toMatchObject({ status: 403 });
    expect((await svc.withdraw(OWNER_A, 'c1', 'Need more checks')).status).toBe('OPEN');
    expect(db.rows('adminAuditLog').map((r) => r.action)).toContain('aml.case.withdraw_proposal');
  });
});

describe('ComplianceReviewService: other cases', () => {
  it('PEP: a sub-admin clears it; the user is CLEAR and the verification approved', async () => {
    const { svc, db, basic } = await setup({ category: 'PEP', amlStatus: 'UNDER_REVIEW' });
    expect((await svc.decide(SUB, 'c1', { decision: 'PEP_APPROVED_EDD', reason: 'EDD done: source of funds checked' })).status).toBe('PEP_APPROVED_EDD');
    expect(db.rows('user')[0].amlStatus).toBe('CLEAR');
    expect(basic.approve).toHaveBeenCalled();
  });

  it('another open case keeps the user under review', async () => {
    const { svc, db } = await setup({ category: 'PEP', amlStatus: 'UNDER_REVIEW' });
    await db.amlScreening.create({ data: { id: 's2', userId: 'u1', inputs: {}, inputFingerprint: 'g', status: 'UNKNOWN' } });
    await db.amlReviewCase.create({ data: { id: 'c2', userId: 'u1', screeningId: 's2', category: 'UNKNOWN', priority: 'NORMAL' } });
    await svc.decide(SUB, 'c1', { decision: 'CLEARED', reason: 'False positive on a common name' });
    expect(db.rows('user')[0].amlStatus).toBe('UNDER_REVIEW');
  });

  it('RESTRICTED then lifted', async () => {
    const { svc, db } = await setup({ category: 'ADVERSE_MEDIA', amlStatus: 'UNDER_REVIEW' });
    await svc.decide(SUB, 'c1', { decision: 'RESTRICTED', reason: 'Pending documents from the user' });
    expect(db.rows('user')[0].amlStatus).toBe('RESTRICTED');
    await svc.decide(SUB, 'c1', { decision: 'CLEARED', reason: 'Documents received and fine' });
    expect(db.rows('user')[0].amlStatus).toBe('CLEAR');
  });

  it('a decided case cannot be decided again', async () => {
    const { svc } = await setup({ category: 'PEP', status: 'CLEARED', amlStatus: 'CLEAR' });
    await expect(svc.decide(SUB, 'c1', { decision: 'RESTRICTED', reason: 'changed my mind' })).rejects.toMatchObject({ status: 409 });
  });

  it('re-screen: ERROR cases only, at most 3, audited, budget reset, one send', async () => {
    const { svc, db, aml } = await setup({ category: 'ERROR', amlStatus: 'UNDER_REVIEW' });
    expect((await svc.rescreen(SUB, 'c1', 'Dojah was down all morning')).rescreenCount).toBe(1);
    expect(db.rows('amlScreening')[0]).toMatchObject({ status: 'PENDING', unknownCount: 0, definiteFailCount: 0, callOutcome: null });
    expect(aml.send).toHaveBeenCalledWith('s1');
    expect(db.rows('adminAuditLog').map((r) => r.action)).toContain('aml.rescreen');
    await db.amlScreening.updateMany({ where: { id: 's1' }, data: { status: 'ERROR' } });
    await svc.rescreen(SUB, 'c1', 'again, still down');
    await db.amlScreening.updateMany({ where: { id: 's1' }, data: { status: 'ERROR' } });
    await svc.rescreen(SUB, 'c1', 'again, still down');
    await db.amlScreening.updateMany({ where: { id: 's1' }, data: { status: 'ERROR' } });
    await expect(svc.rescreen(SUB, 'c1', 'again, still down')).rejects.toMatchObject({ status: 409 });
  });

  it('re-screen is refused while one is already running', async () => {
    const { svc, db } = await setup({ category: 'ERROR', amlStatus: 'UNDER_REVIEW' });
    await db.amlScreening.updateMany({ where: { id: 's1' }, data: { status: 'PENDING' } });
    await expect(svc.rescreen(SUB, 'c1', 'try again please')).rejects.toMatchObject({ status: 409 });
  });

  it('re-screen is refused on a case that had a real result', async () => {
    const { svc } = await setup({ category: 'PEP', amlStatus: 'UNDER_REVIEW' });
    await expect(svc.rescreen(SUB, 'c1', 'try again')).rejects.toMatchObject({ status: 409 });
  });

  it('viewing a case is audited with the IP', async () => {
    const { svc, db } = await setup();
    await svc.detail(OWNER_A, 'c1');
    expect(db.rows('adminAuditLog')[0]).toMatchObject({ action: 'aml.case.view', entityId: 'c1', ip: '203.0.113.1' });
  });

  it('the queue puts sanctions first, then the oldest', async () => {
    const { svc, db } = await setup();
    await db.amlScreening.create({ data: { id: 's3', userId: 'u1', inputs: {}, inputFingerprint: 'h', status: 'UNKNOWN' } });
    await db.amlReviewCase.create({ data: { id: 'c3', userId: 'u1', screeningId: 's3', category: 'UNKNOWN', priority: 'NORMAL', createdAt: new Date(0) } });
    expect((await svc.list('open')).map((c) => c.id)).toEqual(['c1', 'c3']);
  });

  it('a failing audit write rolls a decision back', async () => {
    const { svc, db } = await setup({ category: 'PEP', amlStatus: 'UNDER_REVIEW' });
    db.failNext('adminAuditLog', 'create', new Error('audit down'));
    await expect(svc.decide(SUB, 'c1', { decision: 'CLEARED', reason: 'False positive on a common name' })).rejects.toThrow('audit down');
    expect(db.rows('amlReviewCase')[0].status).toBe('OPEN');
    expect(db.rows('user')[0].amlStatus).toBe('UNDER_REVIEW');
  });
});

describe('release never undoes a confirmed sanctions block, and never strands a verification', () => {
  it('clearing another case does not unblock a person with a CONFIRMED sanctions case', async () => {
    const { svc, db } = await setup({ category: 'PEP', amlStatus: 'BLOCKED' });
    await db.amlScreening.create({ data: { id: 's9', userId: 'u1', inputs: {}, inputFingerprint: 'z', status: 'CONFIRMED_MATCH', category: 'SANCTIONS' } });
    await db.amlReviewCase.create({ data: { id: 'c9', userId: 'u1', screeningId: 's9', category: 'SANCTIONS', priority: 'CRITICAL', status: 'SANCTIONS_CONFIRMED' } });
    await svc.decide(SUB, 'c1', { decision: 'CLEARED', reason: 'False positive on a common name' });
    expect(db.rows('user')[0].amlStatus).toBe('BLOCKED');
  });

  it('a non-sanctions clearance never lifts BLOCKED, even with nothing else open', async () => {
    const { svc, db } = await setup({ category: 'PEP', amlStatus: 'BLOCKED' });
    await svc.decide(SUB, 'c1', { decision: 'CLEARED', reason: 'False positive on a common name' });
    expect(db.rows('user')[0].amlStatus).toBe('BLOCKED');
  });

  it('clearing the last open case approves every verification still waiting in COMPLIANCE_REVIEW', async () => {
    const { svc, db, basic } = await setup({ category: 'PEP', amlStatus: 'UNDER_REVIEW' });
    await db.amlScreening.create({ data: { id: 's2', userId: 'u1', inputs: {}, inputFingerprint: 'g', status: 'UNKNOWN' } });
    await db.amlReviewCase.create({ data: { id: 'c2', userId: 'u1', screeningId: 's2', category: 'UNKNOWN', priority: 'NORMAL' } });
    await db.kycVerification.updateMany({ where: { id: 'v1' }, data: { activeFor: null } });
    await db.kycVerification.create({ data: { id: 'v2', userId: 'u1', activeFor: 'u1', state: 'COMPLIANCE_REVIEW', lagosDay: '2026-10-14', idType: 'BVN', idHash: 'h1:y', idLast4: '1111', typedFirstName: 'A', typedLastName: 'B', typedDateOfBirth: '2000-01-01', typedAddress: {}, screeningId: 's2' } });
    await svc.decide(SUB, 'c1', { decision: 'CLEARED', reason: 'False positive on a common name' }); // c2 still open
    expect(basic.approve).not.toHaveBeenCalled();
    await svc.decide(SUB, 'c2', { decision: 'CLEARED', reason: 'Unclear result reviewed, fine' });
    expect(db.rows('user')[0].amlStatus).toBe('CLEAR');
    expect(basic.approve.mock.calls.map((c) => c[1]).sort()).toEqual(['v1', 'v2']);
  });
});
