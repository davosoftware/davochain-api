import { FakePrisma } from '../ngn-deposits/testing/fake-prisma';
import { DojahMockClient } from '../dojah/dojah.mock';
import { AmlService } from '../compliance/aml.service';
import { KycHashService } from './kyc-hash';
import { BasicVerificationService, MSG_DISABLED, MSG_IN_PROGRESS, MSG_UNAVAILABLE } from './basic-verification.service';

const KEY = 'k'.repeat(32);
const input = (over: Record<string, unknown> = {}) => ({
  idType: 'BVN' as const, idNumber: '22222222222', firstName: 'John', middleName: 'Doe', lastName: 'Ajayi', dateOfBirth: '2000-05-01',
  address: { street: '1 Marina', city: 'Lagos', state: 'Lagos', lga: 'Ikeja' }, stateOfOrigin: 'Ogun', country: 'NG' as const, ...over,
});

async function setup(opts: { enabled?: boolean; ready?: boolean; dojah?: DojahMockClient } = {}) {
  const db = new FakePrisma();
  const dojah = opts.dojah ?? new DojahMockClient();
  const alerts = { raise: jest.fn(async (..._a: unknown[]) => true) };
  const aml = new AmlService(db as never, dojah, alerts as never, { setDesiredForUser: jest.fn() } as never);
  const cfg = { basicEnabled: opts.enabled ?? true, dailyAttempts: 3, totalAttempts: 10 };
  const readiness = {
    assertReady: jest.fn(async () => {
      if (opts.ready === false) throw new Error('not ready');
    }),
    markNotReady: jest.fn(),
  };
  const mail = { send: jest.fn(async (..._a: unknown[]) => undefined) };
  const referrals = { onKycChanged: jest.fn(async (..._a: unknown[]) => undefined) };
  const hasher = new KycHashService({ get: () => KEY } as never);
  const svc = new BasicVerificationService(db as never, dojah, cfg as never, aml, hasher, mail as never, referrals as never, alerts as never, readiness as never);
  svc.onModuleInit();
  await db.user.create({ data: { id: 'u1', email: 'u1@x.test', firstName: 'John', lastName: 'Ajayi' } });
  return { db, dojah, svc, mail, referrals, alerts, readiness };
}

describe('BasicVerificationService', () => {
  it('is 503 "not available yet" while KYC_BASIC_ENABLED is off, and calls nobody', async () => {
    const { svc, dojah } = await setup({ enabled: false });
    await expect(svc.submit('u1', input())).rejects.toMatchObject({ status: 503, message: MSG_DISABLED });
    expect(dojah.calls.lookup).toBe(0);
  });

  it('is 503 "temporarily unavailable" when readiness is not green', async () => {
    const { svc, dojah } = await setup({ ready: false });
    await expect(svc.submit('u1', input())).rejects.toMatchObject({ status: 503, message: MSG_UNAVAILABLE });
    expect(dojah.calls.lookup).toBe(0);
  });

  it('a clean pass with a clear screen is Basic at once (mock identity "Clean")', async () => {
    const dojah = new DojahMockClient();
    jest.spyOn(dojah, 'lookup').mockResolvedValue({ found: true, httpStatus: 200, identity: { usable: true, firstName: 'John', middleName: 'Doe', lastName: 'Clean', dateOfBirth: '2000-05-01', gender: 'MALE', customerRef: 'c' } });
    const { svc, db, mail, referrals } = await setup({ dojah });
    await db.refreshToken.create({ data: { userId: 'u1', revokedAt: null } });
    const r = await svc.submit('u1', input({ lastName: 'Clean' }));
    expect(r).toEqual({ state: 'APPROVED', level: 'BASIC', message: 'You are verified.' });
    const user = db.rows('user')[0];
    expect(user).toMatchObject({ kycTier: 'TIER_1', kycStatus: 'APPROVED', amlStatus: 'CLEAR' });
    const profile = db.rows('kycProfile')[0];
    expect(profile).toMatchObject({ tier: 'TIER_1', status: 'APPROVED', bvnLast4: '2222', lga: 'Ikeja', stateOfOrigin: 'Ogun' });
    expect(String(profile.bvnHash)).toMatch(/^h1:/);
    expect(db.rows('kycVerification')[0]).toMatchObject({ activeFor: null, state: 'APPROVED' });
    expect(db.rows('refreshToken')[0].revokedAt).toBeInstanceOf(Date);
    expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({ key: 'kyc.approved' }));
    expect(referrals.onKycChanged).toHaveBeenCalledWith('u1');
  });

  it('the raw number is never written anywhere (spec §10)', async () => {
    const { svc, db, mail, alerts } = await setup();
    await svc.submit('u1', input());
    const everything = JSON.stringify([db.allWrites(), mail.send.mock.calls, alerts.raise.mock.calls]);
    expect(everything).not.toContain('22222222222');
  });

  it('the sandbox identity goes to compliance review (AML "Unknown" + PEP), with a generic message', async () => {
    const { svc, db } = await setup();
    const r = await svc.submit('u1', input());
    expect(r).toEqual({ state: 'COMPLIANCE_REVIEW', level: 'NONE', message: 'We are reviewing your details. We will email you when it is done.' });
    expect(db.rows('user')[0]).toMatchObject({ kycStatus: 'PENDING', amlStatus: 'UNDER_REVIEW' });
  });

  it('a name mismatch goes to identity review and still screens the verified record', async () => {
    const { svc, db } = await setup();
    const r = await svc.submit('u1', input({ idNumber: '33333333333', firstName: 'Wrong', lastName: 'Name' }));
    expect(r.state).toBe('IDENTITY_REVIEW');
    expect(db.rows('kycVerification')[0]).toMatchObject({ reviewReason: 'NAME_MISMATCH', state: 'IDENTITY_REVIEW' });
    expect(db.rows('amlScreening')).toHaveLength(1);
  });

  it('a date-of-birth mismatch is DOB_MISMATCH; an unusable record is UNUSABLE_RECORD', async () => {
    const a = await setup();
    await a.svc.submit('u1', input({ idNumber: '44444444444', firstName: 'Test', lastName: 'Clean', dateOfBirth: '1980-12-13', middleName: undefined }));
    expect(a.db.rows('kycVerification')[0].reviewReason).toBe('DOB_MISMATCH');
    const b = await setup();
    await b.svc.submit('u1', input({ idNumber: '55555555555', firstName: 'Test', lastName: 'Clean', middleName: undefined }));
    expect(b.db.rows('kycVerification')[0].reviewReason).toBe('UNUSABLE_RECORD');
  });

  it('404 is a rejection that counts as an attempt and frees the slot', async () => {
    const { svc, db } = await setup();
    const r = await svc.submit('u1', input({ idNumber: '11111111111' }));
    expect(r).toEqual({ state: 'REJECTED_NOT_FOUND', level: 'NONE', message: 'We could not find that BVN/NIN. Check the number and try again.' });
    expect(db.rows('kycVerification')[0]).toMatchObject({ activeFor: null, possiblyCharged: true });
    expect(await svc.attemptsLeft('u1')).toEqual({ today: 2, total: 9 });
  });

  it.each([
    ['40100000001', 'AUTH', 'DEFINITELY_FAILED', false],
    ['40300000001', 'IP', 'DEFINITELY_FAILED', false],
    ['40200000001', 'WALLET', 'DEFINITELY_FAILED', false],
    ['50000000001', 'SERVER', 'DEFINITELY_FAILED', false],
    ['99999999999', 'UNKNOWN', 'UNKNOWN', true],
  ])('system failure %s (%s): 503, FAILED_SYSTEM, not an attempt, outcome %s, possiblyCharged %s', async (n, kind, outcome, charged) => {
    const { svc, db, alerts, readiness } = await setup();
    await expect(svc.submit('u1', input({ idNumber: n }))).rejects.toMatchObject({ status: 503, message: MSG_UNAVAILABLE });
    expect(db.rows('kycVerification')[0]).toMatchObject({ state: 'FAILED_SYSTEM', lookupOutcome: outcome, possiblyCharged: charged, activeFor: null });
    expect(await svc.attemptsLeft('u1')).toEqual({ today: 3, total: 10 });
    expect(alerts.raise).toHaveBeenCalledWith('DOJAH_CONFIG', `dojah:${kind}`, expect.any(String), expect.any(Array));
    if (kind === 'WALLET') expect(readiness.markNotReady).toHaveBeenCalledWith('wallet');
  });

  it('a second submit while one is active is 409 and never reaches Dojah', async () => {
    const { svc, db, dojah } = await setup();
    await db.kycVerification.create({ data: { userId: 'u1', activeFor: 'u1', state: 'IDENTITY_REVIEW', lagosDay: '2026-10-14', idType: 'BVN', idHash: 'h1:x', idLast4: '0000', typedFirstName: 'a', typedLastName: 'b', typedDateOfBirth: '2000-01-01', typedAddress: {} } });
    await expect(svc.submit('u1', input())).rejects.toMatchObject({ status: 409, message: MSG_IN_PROGRESS });
    expect(dojah.calls.lookup).toBe(0);
  });

  it('the daily limit (3) and total limit (10) are enforced under the per-user lock', async () => {
    const { svc, db } = await setup();
    for (let i = 0; i < 3; i++) await svc.submit('u1', input({ idNumber: '11111111111' }));
    await expect(svc.submit('u1', input())).rejects.toMatchObject({ status: 429 });
    expect(db.rawCalls.some((q) => q.includes('pg_advisory_xact_lock'))).toBe(true);
  });

  it('the total limit counts every day', async () => {
    const { svc, db } = await setup();
    for (let i = 0; i < 10; i++) {
      await db.kycVerification.create({ data: { userId: 'u1', state: 'REJECTED_NOT_FOUND', lagosDay: '2026-01-01', idType: 'BVN', idHash: 'h1:x', idLast4: '0000', typedFirstName: 'a', typedLastName: 'b', typedDateOfBirth: '2000-01-01', typedAddress: {} } });
    }
    await expect(svc.submit('u1', input())).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/all your verification attempts/) });
  });

  it('refuses a state or LGA not on the list, before any call', async () => {
    const { svc, dojah } = await setup();
    await expect(svc.submit('u1', input({ address: { street: 'x', city: 'y', state: 'Lagos', lga: 'Nsukka' } }))).rejects.toMatchObject({ status: 400 });
    await expect(svc.submit('u1', input({ stateOfOrigin: 'Atlantis' }))).rejects.toMatchObject({ status: 400 });
    expect(dojah.calls.lookup).toBe(0);
  });

  it('an already verified user is 409', async () => {
    const { svc, db } = await setup();
    await db.user.updateMany({ where: { id: 'u1' }, data: { kycTier: 'TIER_1', kycStatus: 'APPROVED' } });
    await expect(svc.submit('u1', input())).rejects.toMatchObject({ status: 409 });
  });

  it('failStaleLookups: an IN_FLIGHT lookup past the lease is FAILED_SYSTEM, possiblyCharged, slot freed (review focus 3)', async () => {
    const { svc, db } = await setup();
    await db.kycVerification.create({ data: { id: 'v9', userId: 'u1', activeFor: 'u1', state: 'CREATED', lookupOutcome: 'IN_FLIGHT', lookupStartedAt: new Date(Date.now() - 301_000), lagosDay: '2026-10-14', idType: 'BVN', idHash: 'h1:x', idLast4: '0000', typedFirstName: 'a', typedLastName: 'b', typedDateOfBirth: '2000-01-01', typedAddress: {} } });
    expect(await svc.failStaleLookups()).toBe(1);
    expect(db.rows('kycVerification')[0]).toMatchObject({ state: 'FAILED_SYSTEM', lookupOutcome: 'UNKNOWN', possiblyCharged: true, activeFor: null, failureReason: 'LOOKUP_UNRECORDED' });
  });

  it('failStaleLookups also frees a CREATED row that never claimed its lookup (crash before the call)', async () => {
    const { svc, db } = await setup();
    await db.kycVerification.create({ data: { userId: 'u1', activeFor: 'u1', state: 'CREATED', createdAt: new Date(Date.now() - 301_000), lagosDay: '2026-10-14', idType: 'BVN', idHash: 'h1:x', idLast4: '0000', typedFirstName: 'a', typedLastName: 'b', typedDateOfBirth: '2000-01-01', typedAddress: {} } });
    expect(await svc.failStaleLookups()).toBe(1);
    expect(db.rows('kycVerification')[0]).toMatchObject({ state: 'FAILED_SYSTEM', possiblyCharged: false, failureReason: 'NEVER_SENT' });
  });

  it('failStaleLookups leaves a fresh in-flight lookup alone', async () => {
    const { svc, db } = await setup();
    await db.kycVerification.create({ data: { userId: 'u1', activeFor: 'u1', state: 'CREATED', lookupOutcome: 'IN_FLIGHT', lookupStartedAt: new Date(), lagosDay: '2026-10-14', idType: 'BVN', idHash: 'h1:x', idLast4: '0000', typedFirstName: 'a', typedLastName: 'b', typedDateOfBirth: '2000-01-01', typedAddress: {} } });
    expect(await svc.failStaleLookups()).toBe(0);
  });
});

describe('final review C1: a person who is not AML-CLEAR never becomes Basic', () => {
  it.each(['BLOCKED', 'UNDER_REVIEW', 'RESTRICTED', 'PENDING'])('submit is refused while amlStatus is %s, before any Dojah call', async (amlStatus) => {
    const { svc, db, dojah } = await setup();
    await db.user.updateMany({ where: { id: 'u1' }, data: { amlStatus } });
    await expect(svc.submit('u1', input())).rejects.toMatchObject({ status: 403, message: 'Your account is under review. Contact support.' });
    expect(dojah.calls.lookup).toBe(0);
  });

  it('approve() parks the verification in COMPLIANCE_REVIEW instead of approving a person who is not CLEAR', async () => {
    const { svc, db, mail } = await setup();
    await db.user.updateMany({ where: { id: 'u1' }, data: { amlStatus: 'BLOCKED' } });
    await db.kycVerification.create({ data: { id: 'vx', userId: 'u1', activeFor: 'u1', state: 'IDENTITY_REVIEW', lagosDay: '2026-10-14', idType: 'BVN', idHash: 'h1:x', idLast4: '0000', typedFirstName: 'a', typedLastName: 'b', typedDateOfBirth: '2000-01-01', typedAddress: {} } });
    const effects = await db.$transaction((tx) => svc.approve(tx as never, 'vx'));
    expect(effects).toEqual([]);
    expect(db.rows('kycVerification')[0].state).toBe('COMPLIANCE_REVIEW');
    expect(db.rows('user')[0]).toMatchObject({ kycTier: 'TIER_0', amlStatus: 'BLOCKED' });
    expect(mail.send).not.toHaveBeenCalled();
  });
});
