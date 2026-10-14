import { FakePrisma } from '../ngn-deposits/testing/fake-prisma';
import { BasicReviewService } from './basic-review.service';
import { AdminService } from '../admin/admin.service';

async function setup(screening: { status: string } | null, state = 'IDENTITY_REVIEW') {
  const db = new FakePrisma();
  await db.user.create({ data: { id: 'u1', email: 'u@x.test', firstName: 'A', lastName: 'B', amlStatus: screening?.status === 'CLEAR' ? 'CLEAR' : 'PENDING' } });
  await db.kycProfile.create({ data: { userId: 'u1', status: 'PENDING' } });
  if (screening) await db.amlScreening.create({ data: { id: 's1', userId: 'u1', inputs: {}, inputFingerprint: 'f', status: screening.status } });
  await db.kycVerification.create({ data: { id: 'v1', userId: 'u1', activeFor: 'u1', state, lagosDay: '2026-10-14', idType: 'BVN', idHash: 'h1:x', idLast4: '2222', typedFirstName: 'A', typedLastName: 'B', typedDateOfBirth: '2000-01-01', typedAddress: {}, screeningId: screening ? 's1' : null } });
  const basic = {
    approve: jest.fn(async (_tx: unknown, id: string) => {
      await db.kycVerification.updateMany({ where: { id }, data: { state: 'APPROVED', activeFor: null } });
      return [];
    }),
  };
  const mail = { send: jest.fn(async (..._a: unknown[]) => undefined) };
  return { db, basic, mail, svc: new BasicReviewService(db as never, basic as never, mail as never) };
}
const actor = { adminId: 'a1', ip: '203.0.113.5' };

describe('BasicReviewService.decide', () => {
  it('approve with a CLEAR screening: APPROVED, audited in the same transaction with the IP', async () => {
    const { svc, db } = await setup({ status: 'CLEAR' });
    expect(await svc.decide(actor, 'u1', { approve: true, reason: 'Name order differs only' })).toEqual({ state: 'APPROVED' });
    expect(db.rows('kycVerification')[0]).toMatchObject({ decidedBy: 'a1', decisionReason: 'Name order differs only' });
    expect(db.rows('adminAuditLog')[0]).toMatchObject({ action: 'kyc.basic.approve', adminUserId: 'a1', entityId: 'v1', ip: '203.0.113.5' });
  });

  it('approve with a non-clear screening: COMPLIANCE_REVIEW, not approved', async () => {
    const { svc, db, basic } = await setup({ status: 'UNKNOWN' });
    expect((await svc.decide(actor, 'u1', { approve: true, reason: 'Identity confirmed by phone' })).state).toBe('COMPLIANCE_REVIEW');
    expect(basic.approve).not.toHaveBeenCalled();
    expect(db.rows('kycVerification')[0].activeFor).toBe('u1');
  });

  it('approve while AML is still running is 409', async () => {
    const { svc } = await setup({ status: 'PENDING' });
    await expect(svc.decide(actor, 'u1', { approve: true, reason: 'looks right' })).rejects.toMatchObject({ status: 409 });
  });

  it('approve with no screenable identity is 409 (reject instead)', async () => {
    const { svc } = await setup(null);
    await expect(svc.decide(actor, 'u1', { approve: true, reason: 'looks right' })).rejects.toMatchObject({ status: 409 });
  });

  it('reject: REJECTED_BY_REVIEW, slot freed, reason emailed, audited', async () => {
    const { svc, db, mail } = await setup({ status: 'CLEAR' });
    expect((await svc.decide(actor, 'u1', { approve: false, reason: 'The names do not match the BVN' })).state).toBe('REJECTED_BY_REVIEW');
    expect(db.rows('kycVerification')[0]).toMatchObject({ activeFor: null });
    expect(db.rows('kycProfile')[0]).toMatchObject({ status: 'REJECTED', rejectionReason: 'The names do not match the BVN' });
    expect(db.rows('user')[0].kycStatus).toBe('REJECTED');
    expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({ key: 'kyc.rejected' }));
    expect(db.rows('adminAuditLog')[0].action).toBe('kyc.basic.reject');
  });

  it('nothing in IDENTITY_REVIEW is 404', async () => {
    const { svc } = await setup({ status: 'CLEAR' }, 'COMPLIANCE_REVIEW');
    await expect(svc.decide(actor, 'u1', { approve: false, reason: 'whatever reason' })).rejects.toMatchObject({ status: 404 });
  });

  it('a second decision on the same row is 404 (compare-and-set)', async () => {
    const { svc } = await setup({ status: 'CLEAR' });
    await svc.decide(actor, 'u1', { approve: false, reason: 'The names do not match' });
    await expect(svc.decide(actor, 'u1', { approve: true, reason: 'changed my mind now' })).rejects.toMatchObject({ status: 404 });
  });

  it('a failing audit write rolls the decision back', async () => {
    const { svc, db, mail } = await setup({ status: 'CLEAR' });
    db.failNext('adminAuditLog', 'create', new Error('audit down'));
    await expect(svc.decide(actor, 'u1', { approve: false, reason: 'The names do not match' })).rejects.toThrow('audit down');
    expect(db.rows('kycVerification')[0].state).toBe('IDENTITY_REVIEW');
    expect(mail.send).not.toHaveBeenCalled();
  });
});

describe('the old review route (plan ruling 8)', () => {
  it('refuses to grant TIER_1', async () => {
    const prisma = { kycProfile: { findUniqueOrThrow: jest.fn(async () => ({ id: 'p', tier: 'TIER_0' })) } };
    const svc = Object.create(AdminService.prototype) as AdminService;
    (svc as unknown as { prisma: unknown }).prisma = prisma;
    await expect(svc.reviewKyc('a1', 'u1', { approve: true })).rejects.toMatchObject({ status: 400 });
    await expect(svc.reviewKyc('a1', 'u1', { approve: true, tier: 'TIER_1' as never })).rejects.toMatchObject({ status: 400 });
  });
});
