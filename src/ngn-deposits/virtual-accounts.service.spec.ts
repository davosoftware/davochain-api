import { HttpException, Logger } from '@nestjs/common';
import { KycHashService, legacyHashIdentity } from '../kyc/kyc-hash';
import { PayrepError } from '../payrep/payrep.errors';
import { PayrepMock } from '../payrep/payrep.mock';
import { FakePrisma } from './testing/fake-prisma';
import { VirtualAccountsService } from './virtual-accounts.service';

const BVN = '22222223883';
const OTHER = '22222223884';
const NIN = '12345678901';
const USER = '7f3c2a1b-9e8d-4c6f-a1b2-c3d4e5f60718';
const POOL = '7801234567';
const MINUTE = 60_000;

interface Options {
  user?: Record<string, unknown>;
  profile?: Record<string, unknown>;
  readiness?: { depositsEnabled?: boolean; canCreateAccounts?: boolean };
  mainAccount?: string | null;
}

async function setup(o: Options = {}) {
  const db = new FakePrisma();
  const hasher = new KycHashService({ get: () => 'k'.repeat(32) } as never);
  await db.user.create({
    data: {
      id: USER, email: 'ada@example.com', firstName: 'Ada', lastName: 'Obi', phone: '+2348012345678',
      status: 'ACTIVE', kycTier: 'TIER_1', kycStatus: 'APPROVED', amlStatus: 'CLEAR', ...o.user,
    },
  });
  await db.kycProfile.create({ data: { userId: USER, bvnHash: hasher.hash(BVN), bvnLast4: '3883', ...o.profile } });
  const payrep = new PayrepMock({ port: 1 });
  const cfg = { mainAccount: o.mainAccount === undefined ? POOL : o.mainAccount };
  const readiness = { report: jest.fn(async () => ({ depositsEnabled: true, canCreateAccounts: true, ...o.readiness })) };
  const alerts = { raise: jest.fn(async () => true) };
  const svc = new VirtualAccountsService(db as never, payrep, cfg as never, readiness as never, hasher, alerts as never);
  return { db, payrep, cfg, readiness, alerts, svc };
}

/** The HttpException a call failed with; fails the test if it succeeded. */
async function failure(p: Promise<unknown>): Promise<HttpException> {
  return (await p.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (e: unknown) => e,
  )) as HttpException;
}

describe('VirtualAccountsService.openForUser (Payrep, spec §4)', () => {
  it('opens a pooled, prefixed Payrep account with the verified number and a local phone, and answers 201', async () => {
    const { svc, db, payrep } = await setup();
    const create = jest.spyOn(payrep, 'createCustomerAccount');
    const res = await svc.openForUser(USER, { bvn: BVN });
    expect(res.httpStatus).toBe(201);
    expect(res.body).toMatchObject({ accountNumber: expect.stringMatching(/^20\d{8}$/), bankName: 'Payrep MFB', status: 'ACTIVE' });
    expect(create).toHaveBeenCalledWith({ bvn: BVN, phoneNumber: '08012345678', poolAccountNumber: POOL });
    expect(db.rows('virtualAccount')).toEqual([
      expect.objectContaining({ userId: USER, provider: 'PAYREP', isPrimary: true, source: 'CREATED', identityType: 'BVN', providerStatus: 'active', providerRef: expect.any(String) }),
    ]);
    expect(db.rows('virtualAccountRequest')[0]).toMatchObject({ state: 'IDLE', attemptsInWindow: 1, lastError: null });
  });

  it('leaves the phone out when it is not a Nigerian number', async () => {
    const { svc, payrep } = await setup({ user: { phone: '+447700900123' } });
    const create = jest.spyOn(payrep, 'createCustomerAccount');
    await svc.openForUser(USER, { bvn: BVN });
    expect(create).toHaveBeenCalledWith({ bvn: BVN, phoneNumber: undefined, poolAccountNumber: POOL });
  });

  it('hands back an existing account with 200 and asks Payrep only once', async () => {
    const { svc, payrep } = await setup();
    const create = jest.spyOn(payrep, 'createCustomerAccount');
    const first = await svc.openForUser(USER, { bvn: BVN });
    const again = await svc.openForUser(USER, { bvn: BVN });
    expect(again).toEqual({ httpStatus: 200, body: first.body });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an unverified user', { user: { kycTier: 'TIER_0', kycStatus: 'NOT_STARTED' } }, /Verify your identity/],
    ['a user whose KYC is pending', { user: { kycStatus: 'PENDING' } }, /Verify your identity/],
    ['a suspended user', { user: { status: 'SUSPENDED' } }, /not active/],
    ['while deposits are switched off', { readiness: { depositsEnabled: false } }, /not available yet/],
    ['while the rail is not ready', { readiness: { canCreateAccounts: false } }, /temporarily unavailable/],
  ])('refuses %s with 403 and never calls Payrep', async (_name, options, reason) => {
    const { svc, payrep } = await setup(options as Options);
    const create = jest.spyOn(payrep, 'createCustomerAccount');
    const err = await failure(svc.openForUser(USER, { bvn: BVN }));
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toMatchObject({ code: 'NOT_ELIGIBLE', message: expect.stringMatching(reason as RegExp) });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses both numbers, neither, or a malformed one, before touching anything', async () => {
    const { svc, db } = await setup();
    for (const input of [{ bvn: BVN, nin: NIN }, {}, { bvn: '1234' }]) {
      expect((await failure(svc.openForUser(USER, input))).getStatus()).toBe(400);
    }
    expect(db.rows('virtualAccountRequest')).toHaveLength(0);
  });

  it('refuses a number that does not match KYC, counts the attempt, and goes idle', async () => {
    const { svc, db, payrep } = await setup();
    const create = jest.spyOn(payrep, 'createCustomerAccount');
    const err = await failure(svc.openForUser(USER, { bvn: OTHER }));
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toMatchObject({ code: 'IDENTITY_MISMATCH' });
    expect(create).not.toHaveBeenCalled();
    expect(db.rows('virtualAccount')).toHaveLength(0);
    expect(db.rows('virtualAccountRequest')[0]).toMatchObject({ state: 'IDLE', attemptsInWindow: 1 });
  });

  it('refuses the other kind of number than the one KYC verified', async () => {
    const { svc } = await setup();
    const err = await failure(svc.openForUser(USER, { nin: NIN }));
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toMatchObject({ code: 'IDENTITY_TYPE_MISMATCH', message: expect.stringMatching(/BVN/) });
  });

  it('upgrades a legacy hash to h1: when the number matches', async () => {
    const { svc, db } = await setup({ profile: { bvnHash: legacyHashIdentity(BVN) } });
    await svc.openForUser(USER, { bvn: BVN });
    expect(db.rows('kycProfile')[0].bvnHash).toMatch(/^h1:[0-9a-f]{64}$/);
  });

  it('83 (identity rejected) is a 400 the customer can act on, with a redacted reason kept', async () => {
    const { svc, db, payrep } = await setup();
    jest.spyOn(payrep, 'createCustomerAccount').mockRejectedValueOnce(new PayrepError('REFUSED', `Identity ${BVN} verification failed`, 200, '83'));
    const err = await failure(svc.openForUser(USER, { bvn: BVN }));
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toMatchObject({ code: 'PROVIDER_REJECTED' });
    const request = db.rows('virtualAccountRequest')[0];
    expect(request).toMatchObject({ state: 'IDLE', attemptsInWindow: 1 });
    expect(request.lastError).toBe('Identity [REDACTED] verification failed');
  });

  it('answers 503 and alerts when Payrep refuses our setup', async () => {
    const { svc, db, payrep, alerts } = await setup();
    jest.spyOn(payrep, 'createCustomerAccount').mockRejectedValueOnce(new PayrepError('CONFIG', 'Pool account not found', 200, '42'));
    const err = await failure(svc.openForUser(USER, { bvn: BVN }));
    expect(err.getStatus()).toBe(503);
    expect(alerts.raise).toHaveBeenCalledWith('NAIRA_RAIL_CONFIG', 'config', expect.any(String), expect.any(Array));
    expect(db.rows('virtualAccountRequest')[0].state).toBe('IDLE');
  });

  it('a CONFIG problem (no main account) is 503 and alerts, without calling Payrep', async () => {
    const { svc, payrep, alerts } = await setup({ mainAccount: null });
    const create = jest.spyOn(payrep, 'createCustomerAccount');
    expect((await failure(svc.openForUser(USER, { bvn: BVN }))).getStatus()).toBe(503);
    expect(create).not.toHaveBeenCalled();
    expect(alerts.raise).toHaveBeenCalledWith('NAIRA_RAIL_CONFIG', 'config', expect.any(String), expect.any(Array));
  });

  it('an unclear answer is 202 PENDING; the attempt is UNKNOWN and nothing is recorded', async () => {
    const { svc, db, payrep } = await setup();
    jest.spyOn(payrep, 'createCustomerAccount').mockRejectedValueOnce(new PayrepError('UNCLEAR', 'timeout', 0, null));
    const r = await svc.openForUser(USER, { bvn: BVN });
    expect(r).toEqual({ httpStatus: 202, body: expect.objectContaining({ status: 'PENDING' }) });
    expect(db.rows('virtualAccount')).toHaveLength(0);
    expect(db.rows('virtualAccountRequest')[0].state).toBe('UNKNOWN');
  });

  it('answers 202 and keeps the account number for ops when recording a created account fails', async () => {
    const { svc, db, alerts } = await setup();
    db.failNext('virtualAccount', 'create', new Error('database unavailable'));
    const res = await svc.openForUser(USER, { bvn: BVN });
    expect(res).toEqual({ httpStatus: 202, body: { status: 'PENDING', message: expect.any(String) } });
    expect(db.rows('virtualAccount')).toHaveLength(0);
    expect(db.rows('virtualAccountRequest')[0]).toMatchObject({ state: 'UNKNOWN', lastError: 'database unavailable' });
    expect(alerts.raise).toHaveBeenCalledWith(
      'VIRTUAL_ACCOUNT_SYNC', expect.stringMatching(/^va-unrecorded:20\d{8}$/), expect.any(String),
      expect.arrayContaining([expect.stringMatching(/^Account number: 20\d{8}$/)]), expect.any(Number),
    );
    expect(JSON.stringify(alerts.raise.mock.calls)).not.toContain(BVN);
  });

  it('hands back an account that appeared while the request waited, without claiming or calling Payrep', async () => {
    const { svc, db, payrep, readiness } = await setup();
    const create = jest.spyOn(payrep, 'createCustomerAccount');
    readiness.report.mockImplementationOnce(async () => {
      await db.virtualAccount.create({
        data: { userId: USER, accountNumber: '9000000099', accountName: 'Ada Obi', bankName: 'Payrep MFB', isPrimary: true, source: 'CREATED', providerStatus: 'active' },
      });
      return { depositsEnabled: true, canCreateAccounts: true };
    });
    const res = await svc.openForUser(USER, { bvn: BVN });
    expect(res).toEqual({ httpStatus: 200, body: expect.objectContaining({ accountNumber: '9000000099', status: 'ACTIVE' }) });
    expect(create).not.toHaveBeenCalled();
    expect(db.rows('virtualAccountRequest')).toHaveLength(0);
  });

  it('blocks a second request while one is in flight, but not a stale one', async () => {
    const { svc, db } = await setup();
    await db.virtualAccountRequest.create({
      data: { userId: USER, state: 'CREATING', stateSince: new Date(), windowStartedAt: new Date(), attemptsInWindow: 1 },
    });
    expect((await failure(svc.openForUser(USER, { bvn: BVN }))).getStatus()).toBe(409);
    await db.virtualAccountRequest.update({ where: { userId: USER }, data: { stateSince: new Date(Date.now() - 3 * MINUTE) } });
    await expect(svc.openForUser(USER, { bvn: BVN })).resolves.toMatchObject({ httpStatus: 201 });
  });

  it('allows five attempts in 24 hours, then 429, and starts over a day later', async () => {
    const { svc, db } = await setup();
    await db.virtualAccountRequest.create({
      data: { userId: USER, state: 'IDLE', windowStartedAt: new Date(Date.now() - 60 * MINUTE), attemptsInWindow: 5 },
    });
    const err = await failure(svc.openForUser(USER, { bvn: BVN }));
    expect(err.getStatus()).toBe(429);
    expect(err.getResponse()).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
    await db.virtualAccountRequest.update({ where: { userId: USER }, data: { windowStartedAt: new Date(Date.now() - 25 * 60 * MINUTE) } });
    await expect(svc.openForUser(USER, { bvn: BVN })).resolves.toMatchObject({ httpStatus: 201 });
    expect(db.rows('virtualAccountRequest')[0].attemptsInWindow).toBe(1);
  });

  it('never lets a BVN reach a stored row, an error, an alert or a log line', async () => {
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((m) =>
      jest.spyOn(Logger.prototype, m).mockImplementation((...args: unknown[]) => {
        lines.push(JSON.stringify(args));
      }),
    );
    const evidence: unknown[] = [];
    try {
      const arrangements: Array<(p: PayrepMock) => void> = [
        () => undefined, // success
        (p) => void jest.spyOn(p, 'createCustomerAccount').mockRejectedValueOnce(new PayrepError('REFUSED', `BVN ${BVN} could not be validated`, 200, '83')),
        (p) => void jest.spyOn(p, 'createCustomerAccount').mockRejectedValueOnce(new PayrepError('CONFIG', `key refused for ${BVN}`, 200, '41')),
        (p) => void jest.spyOn(p, 'createCustomerAccount').mockRejectedValueOnce(new PayrepError('UNCLEAR', `timeout while sending ${BVN}`, 0, null)),
      ];
      for (const arrange of arrangements) {
        const s = await setup();
        arrange(s.payrep);
        const outcome = await s.svc.openForUser(USER, { bvn: BVN }).catch((e: unknown) => e);
        evidence.push(outcome instanceof HttpException ? [outcome.message, outcome.getResponse()] : outcome, s.db.allWrites(), s.alerts.raise.mock.calls);
      }
      const mismatch = await setup();
      const refused = await failure(mismatch.svc.openForUser(USER, { bvn: OTHER }));
      evidence.push(refused.message, refused.getResponse(), mismatch.db.allWrites());

      const text = JSON.stringify(evidence) + lines.join('\n');
      expect(text).not.toContain(BVN);
      expect(text).not.toContain(OTHER);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

describe('VirtualAccountsService: reading, owners and "off"', () => {
  it('shows the account, INACTIVE when switched off, and 404 with eligibility when there is none', async () => {
    const { svc, db } = await setup();
    const none = await failure(svc.getForUser(USER));
    expect(none.getStatus()).toBe(404);
    expect(none.getResponse()).toMatchObject({ code: 'NO_VIRTUAL_ACCOUNT', eligible: true, reason: null });
    await svc.openForUser(USER, { bvn: BVN });
    await expect(svc.getForUser(USER)).resolves.toMatchObject({ status: 'ACTIVE', bankName: 'Payrep MFB' });
    await db.virtualAccount.updateMany({ where: { userId: USER }, data: { desiredStatus: 'INACTIVE' } });
    await expect(svc.getForUser(USER)).resolves.toMatchObject({ status: 'INACTIVE' });
  });

  it('findOwnerByAccount knows switched-off accounts (Review Focus 4)', async () => {
    const { svc } = await setup();
    await svc.openForUser(USER, { bvn: BVN });
    const [va] = await svc.listForUser(USER);
    await expect(svc.findOwnerByAccount(va.accountNumber)).resolves.toEqual({ userId: USER, switchedOff: false });
    await svc.setDesiredForUser(USER, 'INACTIVE');
    await expect(svc.findOwnerByAccount(va.accountNumber)).resolves.toEqual({ userId: USER, switchedOff: true });
    await expect(svc.findOwnerByAccount('0000000000')).resolves.toBeNull();
  });

  it('setDesiredForUser only records the wish (Payrep has no switch-off API) and never throws', async () => {
    const { svc, db, payrep } = await setup();
    await svc.openForUser(USER, { bvn: BVN });
    const calls = jest.spyOn(payrep, 'createCustomerAccount');
    await svc.setDesiredForUser(USER, 'INACTIVE', { background: true });
    expect(db.rows('virtualAccount')[0]).toMatchObject({ desiredStatus: 'INACTIVE' });
    expect(calls).not.toHaveBeenCalled();
    db.failNext('virtualAccount', 'updateMany', new Error('database unavailable'));
    await expect(svc.setDesiredForUser(USER, 'ACTIVE')).resolves.toBeUndefined();
  });

  it("lets an admin switch one account, refusing another user's with 404", async () => {
    const { svc, db } = await setup();
    await svc.openForUser(USER, { bvn: BVN });
    const vaId = db.rows('virtualAccount')[0].id as string;
    expect((await failure(svc.setDesired('someone-else', vaId, 'INACTIVE'))).getStatus()).toBe(404);
    const { before, after } = await svc.setDesired(USER, vaId, 'INACTIVE');
    expect(before).toMatchObject({ id: vaId, desiredStatus: 'ACTIVE' });
    expect(after).toMatchObject({ id: vaId, desiredStatus: 'INACTIVE', providerRef: expect.any(String) });
    await expect(svc.listForUser(USER)).resolves.toEqual([expect.objectContaining({ id: vaId, desiredStatus: 'INACTIVE' })]);
  });
});

describe('final review C1: a person not AML-CLEAR cannot open a naira deposit account', () => {
  it.each(['BLOCKED', 'UNDER_REVIEW', 'RESTRICTED', 'PENDING', 'NOT_SCREENED'])('%s is not eligible, with the generic wording', async (amlStatus) => {
    const { svc } = await setup({ user: { amlStatus } });
    const r = await svc.eligibility(USER);
    expect(r.eligible).toBe(false);
    expect(r.reason).not.toMatch(/sanction|aml|pep|blocked/i);
  });
});
