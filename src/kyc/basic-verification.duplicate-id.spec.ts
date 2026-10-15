import { FakePrisma } from '../ngn-deposits/testing/fake-prisma';
import { DojahMockClient } from '../dojah/dojah.mock';
import { AmlService } from '../compliance/aml.service';
import { KycHashService } from './kyc-hash';
import { BasicVerificationService, MSG_ID_IN_USE } from './basic-verification.service';

/**
 * H8 (PROJECT_REVIEW): one BVN/NIN verifies one DavoChain account. A second
 * account using the same number is refused before the paid Dojah lookup, and
 * the attempt is not counted against the person (decision 2026-10-15).
 */
const KEY = 'k'.repeat(32);
const input = (over: Record<string, unknown> = {}) => ({
  idType: 'BVN' as const, idNumber: '22222222222', firstName: 'John', middleName: 'Doe', lastName: 'Clean', dateOfBirth: '2000-05-01',
  address: { street: '1 Marina', city: 'Lagos', state: 'Lagos', lga: 'Ikeja' }, stateOfOrigin: 'Ogun', country: 'NG' as const, ...over,
});

async function setup() {
  const db = new FakePrisma();
  const dojah = new DojahMockClient();
  jest.spyOn(dojah, 'lookup').mockResolvedValue({ found: true, httpStatus: 200, identity: { usable: true, firstName: 'John', middleName: 'Doe', lastName: 'Clean', dateOfBirth: '2000-05-01', gender: 'MALE', customerRef: 'c' } });
  const alerts = { raise: jest.fn(async (..._a: unknown[]) => true) };
  const aml = new AmlService(db as never, dojah, alerts as never, { setDesiredForUser: jest.fn() } as never);
  const cfg = { effective: async () => ({ basicEnabled: true, dailyAttempts: 3, totalAttempts: 10, minBalance: 0, lowBalanceWarn: null, source: {} }) };
  const readiness = { assertReady: jest.fn(async () => undefined), markNotReady: jest.fn() };
  const hasher = new KycHashService({ get: () => KEY } as never);
  const svc = new BasicVerificationService(db as never, dojah, cfg as never, aml, hasher, { send: jest.fn() } as never, { onKycChanged: jest.fn() } as never, alerts as never, readiness as never);
  svc.onModuleInit();
  for (const id of ['u1', 'u2']) await db.user.create({ data: { id, email: `${id}@x.test`, firstName: 'John', lastName: 'Clean' } });
  return { db, dojah, svc };
}

describe('H8: one BVN/NIN verifies one account', () => {
  it('the first account to use a BVN is verified', async () => {
    const { svc } = await setup();
    await expect(svc.submit('u1', input())).resolves.toMatchObject({ state: 'APPROVED' });
  });

  it('a second account with the same BVN is refused before any Dojah call', async () => {
    const { svc, dojah } = await setup();
    await svc.submit('u1', input());
    const lookups = (dojah.lookup as jest.Mock).mock.calls.length;
    await expect(svc.submit('u2', input())).rejects.toMatchObject({ status: 409, message: MSG_ID_IN_USE });
    expect((dojah.lookup as jest.Mock).mock.calls.length).toBe(lookups);
  });

  it('the refused attempt is not counted against the person', async () => {
    const { svc, db } = await setup();
    await svc.submit('u1', input());
    await svc.submit('u2', input()).catch(() => undefined);
    expect(db.rows('kycVerification').filter((v) => v.userId === 'u2')).toHaveLength(0);
  });

  it('a different BVN on the second account is fine', async () => {
    const { svc } = await setup();
    await svc.submit('u1', input());
    await expect(svc.submit('u2', input({ idNumber: '22222222223' }))).resolves.toMatchObject({ state: 'APPROVED' });
  });

  it('a BVN another account is verifying right now is refused too', async () => {
    const { svc, db } = await setup();
    // u1's verification is in flight (claimed, not finished).
    await db.kycVerification.create({
      data: { userId: 'u1', activeFor: 'u1', lagosDay: '2026-10-15', idType: 'BVN', idHash: new KycHashService({ get: () => KEY } as never).hash('22222222222'), idLast4: '2222', state: 'IN_FLIGHT' },
    });
    await expect(svc.submit('u2', input())).rejects.toMatchObject({ status: 409, message: MSG_ID_IN_USE });
  });
});

describe('H8: two accounts verifying the same BVN at the same moment', () => {
  it('the one that reaches approval second goes to identity review, not approved', async () => {
    const { svc, db } = await setup();
    const hash = new KycHashService({ get: () => KEY } as never).hash('22222222222');
    // u1 was approved with this BVN while u2's lookup was already under way.
    await db.kycProfile.create({ data: { userId: 'u1', bvnHash: hash, status: 'APPROVED', tier: 'TIER_1' } });
    await db.user.update({ where: { id: 'u2' }, data: { amlStatus: 'CLEAR' } });
    const v = await db.kycVerification.create({
      data: { userId: 'u2', activeFor: 'u2', lagosDay: '2026-10-15', idType: 'BVN', idHash: hash, idLast4: '2222', state: 'LOOKED_UP' },
    });
    await db.$transaction((tx: never) => svc.approve(tx, v.id as string));
    expect(db.rows('kycVerification').find((r) => r.id === v.id)).toMatchObject({ state: 'IDENTITY_REVIEW' });
    expect(db.rows('user').find((u) => u.id === 'u2')).not.toMatchObject({ kycStatus: 'APPROVED' });
  });
});
