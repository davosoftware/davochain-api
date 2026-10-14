import { HttpException, Logger } from '@nestjs/common';
import { FlutterwaveError, FlutterwaveUnknownError } from '../flutterwave/flutterwave.errors';
import { FlutterwaveMockClient } from '../flutterwave/flutterwave.mock';
import type { FlwStaticAccount } from '../flutterwave/flutterwave.types';
import { KycHashService, legacyHashIdentity } from '../kyc/kyc-hash';
import { FakePrisma } from './testing/fake-prisma';
import { VirtualAccountsService } from './virtual-accounts.service';

const BVN = '22222223883';
const OTHER = '22222223884';
const NIN = '12345678901';
const USER = '7f3c2a1b-9e8d-4c6f-a1b2-c3d4e5f60718';
const TX_REF = 'dcva_7f3c2a1b9e8d4c6fa1b2c3d4e5f60718';
const MINUTE = 60_000;

interface Options {
  user?: Record<string, unknown>;
  profile?: Record<string, unknown>;
  readiness?: { depositsEnabled?: boolean; canCreateAccounts?: boolean };
}

async function setup(o: Options = {}) {
  const db = new FakePrisma();
  const hasher = new KycHashService({ get: () => 'k'.repeat(32) } as never);
  await db.user.create({
    data: {
      id: USER, email: 'ada@example.com', firstName: 'Ada', lastName: 'Obi',
      status: 'ACTIVE', kycTier: 'TIER_1', kycStatus: 'APPROVED', amlStatus: 'CLEAR', ...o.user,
    },
  });
  await db.kycProfile.create({ data: { userId: USER, bvnHash: hasher.hash(BVN), bvnLast4: '3883', ...o.profile } });
  const client = new FlutterwaveMockClient({
    rateLimitPerMinute: 100_000, port: 1, secretKey: async () => 'FLWSECK_TEST-x-X', secretHash: async () => 'h',
  } as never);
  const readiness = { report: jest.fn(async () => ({ depositsEnabled: true, canCreateAccounts: true, ...o.readiness })) };
  const alerts = { raise: jest.fn(async () => true) };
  const svc = new VirtualAccountsService(db as never, client, readiness as never, hasher, alerts as never);
  return { db, client, readiness, alerts, svc };
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

describe('VirtualAccountsService.openForUser', () => {
  it("opens a permanent account with the user's tx_ref, names and BVN, and answers 201", async () => {
    const { svc, db, client } = await setup();
    const create = jest.spyOn(client, 'createStaticVirtualAccount');
    const res = await svc.openForUser(USER, { bvn: BVN });
    expect(res.httpStatus).toBe(201);
    expect(res.body).toMatchObject({ accountName: 'Ada Obi', bankName: 'Flutterwave MFB (mock)', status: 'ACTIVE' });
    expect(create).toHaveBeenCalledWith({
      email: 'ada@example.com', txRef: TX_REF, firstName: 'Ada', lastName: 'Obi', narration: 'Ada Obi', bvn: BVN,
    });
    expect(db.rows('virtualAccount')).toEqual([
      expect.objectContaining({ userId: USER, txRef: TX_REF, isPrimary: true, source: 'CREATED', identityType: 'BVN', providerStatus: 'active' }),
    ]);
    expect(db.rows('virtualAccountRequest')[0]).toMatchObject({ state: 'IDLE', attemptsInWindow: 1, lastError: null });
  });

  it('hands back an existing account with 200 and asks Flutterwave only once', async () => {
    const { svc, client } = await setup();
    const create = jest.spyOn(client, 'createStaticVirtualAccount');
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
  ])('refuses %s with 403 and never calls Flutterwave', async (_name, options, reason) => {
    const { svc, client } = await setup(options as Options);
    const create = jest.spyOn(client, 'createStaticVirtualAccount');
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
    const { svc, db, client } = await setup();
    const create = jest.spyOn(client, 'createStaticVirtualAccount');
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

  it('turns a Flutterwave rejection into 400, counts the attempt, and keeps a redacted reason', async () => {
    const { svc, db, client } = await setup();
    client.failNext('createStaticVirtualAccount', new FlutterwaveError('DEFINITE', `BVN ${BVN} could not be validated`, 400));
    const err = await failure(svc.openForUser(USER, { bvn: BVN }));
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toMatchObject({ code: 'PROVIDER_REJECTED' });
    const request = db.rows('virtualAccountRequest')[0];
    expect(request).toMatchObject({ state: 'IDLE', attemptsInWindow: 1 });
    expect(request.lastError).toBe('BVN [REDACTED] could not be validated');
  });

  it('answers 503 and alerts when Flutterwave refuses our credentials', async () => {
    const { svc, db, client, alerts } = await setup();
    client.failNext('createStaticVirtualAccount', new FlutterwaveError('CONFIG', 'Authorization required', 401));
    const err = await failure(svc.openForUser(USER, { bvn: BVN }));
    expect(err.getStatus()).toBe(503);
    expect(alerts.raise).toHaveBeenCalledWith('FLUTTERWAVE_CONFIG', 'config', expect.any(String), expect.any(Array));
    expect(db.rows('virtualAccountRequest')[0].state).toBe('IDLE');
  });

  it('answers 202 when the outcome is unknown; a retry may open a second account, which still routes to the user', async () => {
    const { svc, db, client } = await setup();
    const real = client.createStaticVirtualAccount.bind(client);
    let orphan: FlwStaticAccount | undefined;
    jest.spyOn(client, 'createStaticVirtualAccount').mockImplementationOnce(async (input) => {
      orphan = await real(input); // Flutterwave made it…
      throw new FlutterwaveUnknownError('Flutterwave POST /virtual-account-numbers did not answer: timeout', 'POST', '/virtual-account-numbers');
    });
    const first = await svc.openForUser(USER, { bvn: BVN });
    expect(first).toEqual({ httpStatus: 202, body: { status: 'PENDING', message: expect.any(String) } });
    expect(db.rows('virtualAccountRequest')[0].state).toBe('UNKNOWN');

    const second = await svc.openForUser(USER, { bvn: BVN }); // …and creation is not idempotent
    expect(second.httpStatus).toBe(201);
    expect(db.rows('virtualAccount')).toHaveLength(1);
    await expect(svc.findOwner(TX_REF, orphan!.account_number)).resolves.toEqual({ userId: USER, via: 'TX_REF', accountKnown: false });
  });

  it('answers 202 and keeps the order ref for ops when recording a created account fails', async () => {
    const { svc, db, alerts } = await setup();
    db.failNext('virtualAccount', 'create', new Error('database unavailable'));
    const res = await svc.openForUser(USER, { bvn: BVN });
    expect(res).toEqual({ httpStatus: 202, body: { status: 'PENDING', message: expect.any(String) } });
    expect(db.rows('virtualAccount')).toHaveLength(0);
    expect(db.rows('virtualAccountRequest')[0]).toMatchObject({ state: 'UNKNOWN', lastError: 'database unavailable' });
    expect(alerts.raise).toHaveBeenCalledWith(
      'VIRTUAL_ACCOUNT_SYNC', expect.stringMatching(/^va-unrecorded:URF_MOCK_/), expect.any(String),
      expect.arrayContaining([expect.stringMatching(/^Order ref: URF_MOCK_/)]), expect.any(Number),
    );
    expect(JSON.stringify(alerts.raise.mock.calls)).not.toContain(BVN);
  });

  it('hands back an account that appeared while the request waited, without claiming or calling Flutterwave', async () => {
    const { svc, db, client, readiness } = await setup();
    const create = jest.spyOn(client, 'createStaticVirtualAccount');
    readiness.report.mockImplementationOnce(async () => {
      // the user's other request finishes while this one checks eligibility
      await db.virtualAccount.create({
        data: { userId: USER, orderRef: 'URF_RACE', accountNumber: '9000000099', accountName: 'Ada Obi', bankName: 'Flutterwave MFB', txRef: TX_REF, isPrimary: true, source: 'CREATED', providerStatus: 'active' },
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
      const arrangements: Array<(c: FlutterwaveMockClient) => void> = [
        () => undefined, // success
        (c) => c.failNext('createStaticVirtualAccount', new FlutterwaveError('DEFINITE', `BVN ${BVN} could not be validated`, 400, `bvn ${BVN}`)),
        (c) => c.failNext('createStaticVirtualAccount', new FlutterwaveError('CONFIG', `key refused for ${BVN}`, 401)),
        (c) => c.failNext('createStaticVirtualAccount', new FlutterwaveUnknownError(`timeout while sending ${BVN}`, 'POST', '/virtual-account-numbers')),
      ];
      for (const arrange of arrangements) {
        const s = await setup();
        arrange(s.client);
        const outcome = await s.svc.openForUser(USER, { bvn: BVN }).catch((e: unknown) => e);
        evidence.push(
          outcome instanceof HttpException ? [outcome.message, outcome.getResponse()] : outcome,
          s.db.allWrites(),
          s.alerts.raise.mock.calls,
        );
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

describe('VirtualAccountsService: reading, routing and status', () => {
  it('shows the account, INACTIVE when Flutterwave says so, and 404 with eligibility when there is none', async () => {
    const { svc, db } = await setup();
    const none = await failure(svc.getForUser(USER));
    expect(none.getStatus()).toBe(404);
    expect(none.getResponse()).toMatchObject({ code: 'NO_VIRTUAL_ACCOUNT', eligible: true, reason: null });
    await svc.openForUser(USER, { bvn: BVN });
    await expect(svc.getForUser(USER)).resolves.toMatchObject({ status: 'ACTIVE', accountName: 'Ada Obi' });
    await db.virtualAccount.updateMany({ where: { userId: USER }, data: { providerStatus: 'inactive' } });
    await expect(svc.getForUser(USER)).resolves.toMatchObject({ status: 'INACTIVE' });
  });

  it('finds the owner by tx_ref first, then by account number, and refuses an ambiguous number', async () => {
    const { svc, db } = await setup();
    await svc.openForUser(USER, { bvn: BVN });
    const number = db.rows('virtualAccount')[0].accountNumber as string;
    await expect(svc.findOwner(TX_REF, number)).resolves.toEqual({ userId: USER, via: 'TX_REF', accountKnown: true });
    await expect(svc.findOwner('dcbt_someone_else', number)).resolves.toEqual({ userId: USER, via: 'ACCOUNT_NUMBER', accountKnown: true });
    await expect(svc.findOwner('dcbt_someone_else', '0000000001')).resolves.toBeNull();
    await expect(svc.findOwner('dcva_00000000000000000000000000000000', null)).resolves.toBeNull();

    await db.user.create({ data: { id: 'u2', email: 'b@x.y', firstName: 'B', lastName: 'C' } });
    await db.virtualAccount.create({
      data: { userId: 'u2', accountNumber: number, accountName: 'B C', bankName: 'X', txRef: 'dcva_x', source: 'CREATED' },
    });
    await expect(svc.findOwner(null, number)).resolves.toBeNull();
  });

  it('records a discovered account, primary only when the user has none, and only once', async () => {
    const { svc, db } = await setup();
    const first = await svc.recordDiscovered(USER, '0067100155');
    expect(first).toMatchObject({ source: 'DISCOVERED', isPrimary: true, orderRef: null, accountName: 'Ada Obi', txRef: TX_REF });
    await svc.recordDiscovered(USER, '0067100155');
    expect(db.rows('virtualAccount')).toHaveLength(1);
    expect((await svc.recordDiscovered(USER, '0067100156')).isPrimary).toBe(false);
  });

  it("deactivates a user's accounts at Flutterwave, and never throws when Flutterwave fails", async () => {
    const { svc, db, client } = await setup();
    await svc.openForUser(USER, { bvn: BVN });
    await svc.setDesiredForUser(USER, 'INACTIVE');
    expect(db.rows('virtualAccount')[0]).toMatchObject({ desiredStatus: 'INACTIVE', providerStatus: 'inactive', syncFailures: 0, syncError: null });
    await expect(client.getVirtualAccount(db.rows('virtualAccount')[0].orderRef as string)).resolves.toMatchObject({ account_status: 'inactive' });

    client.failNext('setVirtualAccountStatus', new FlutterwaveUnknownError('timeout', 'POST', '/virtual-account-numbers/x'));
    await expect(svc.setDesiredForUser(USER, 'ACTIVE')).resolves.toBeUndefined();
    expect(db.rows('virtualAccount')[0]).toMatchObject({ desiredStatus: 'ACTIVE', providerStatus: 'inactive', syncFailures: 1 });
  });

  it('re-pushes accounts Flutterwave disagrees about, skips ones it cannot manage, and alerts after three failed runs', async () => {
    const { svc, db, client, alerts } = await setup();
    await svc.openForUser(USER, { bvn: BVN });
    await svc.recordDiscovered(USER, '0067100155'); // no order ref: cannot be pushed
    await db.virtualAccount.updateMany({ where: { userId: USER }, data: { desiredStatus: 'INACTIVE' } });
    const push = jest
      .spyOn(client, 'setVirtualAccountStatus')
      .mockRejectedValue(new FlutterwaveUnknownError('timeout', 'POST', '/virtual-account-numbers/x'));
    for (let run = 1; run <= 3; run++) await svc.syncStatuses();
    expect(push).toHaveBeenCalledTimes(3);
    expect(alerts.raise).toHaveBeenCalledTimes(1);
    expect(alerts.raise).toHaveBeenCalledWith(
      'VIRTUAL_ACCOUNT_SYNC', expect.stringMatching(/^va-sync:/), expect.any(String), expect.any(Array), expect.any(Number),
    );
    push.mockRestore();
    await expect(svc.syncStatuses()).resolves.toEqual({ checked: 1, fixed: 1, failing: 0 });
    expect(db.rows('virtualAccount').find((r) => r.orderRef)).toMatchObject({ providerStatus: 'inactive', syncFailures: 0 });
  });

  it("lets an admin switch one account, refusing another user's with 404", async () => {
    const { svc, db } = await setup();
    await svc.openForUser(USER, { bvn: BVN });
    const vaId = db.rows('virtualAccount')[0].id as string;
    expect((await failure(svc.setDesired('someone-else', vaId, 'INACTIVE'))).getStatus()).toBe(404);
    const { before, after } = await svc.setDesired(USER, vaId, 'INACTIVE');
    expect(before).toMatchObject({ id: vaId, desiredStatus: 'ACTIVE' });
    expect(after).toMatchObject({ id: vaId, desiredStatus: 'INACTIVE', providerStatus: 'inactive' });
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
