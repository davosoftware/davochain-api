import { HttpException, Logger } from '@nestjs/common';
import { PayrepError } from '../payrep/payrep.errors';
import { PayrepMock } from '../payrep/payrep.mock';
import { FakePrisma } from './testing/fake-prisma';
import { VirtualAccountsService } from './virtual-accounts.service';

/**
 * Naira deposit accounts WITHOUT BVN or NIN (spec 2026-10-23): Payrep
 * create_account, named from the customer's ID record, pooled into our main
 * account, opened automatically once Basic is approved.
 */
const USER = '7f3c2a1b-9e8d-4c6f-a1b2-c3d4e5f60718';
const OTHER_USER = '0d1e2f3a-4b5c-4d6e-8f70-819203a4b5c6';
const POOL = '7801234567';
const MINUTE = 60_000;

interface Options {
  user?: Record<string, unknown>;
  record?: Record<string, unknown> | null;
  readiness?: { depositsEnabled?: boolean; canCreateAccounts?: boolean };
  mainAccount?: string | null;
  prefix?: string;
}

async function setup(o: Options = {}) {
  const db = new FakePrisma();
  await db.user.create({
    data: {
      id: USER, email: 'ada@example.com', firstName: 'Ada', lastName: 'Obi', phone: '+2348012345678',
      status: 'ACTIVE', kycTier: 'TIER_1', kycStatus: 'APPROVED', amlStatus: 'CLEAR', ...o.user,
    },
  });
  if (o.record !== null) {
    await db.kycVerification.create({
      data: {
        id: 'kv-1', userId: USER, state: 'APPROVED', idType: 'BVN', createdAt: new Date(Date.now() - 10 * MINUTE),
        recordFirstName: 'ADA', recordMiddleName: 'CHIOMA', recordLastName: 'OBI', ...o.record,
      },
    });
  }
  const payrep = new PayrepMock({ port: 1 });
  const cfg = { mainAccount: o.mainAccount === undefined ? POOL : o.mainAccount, accountNamePrefix: o.prefix ?? '' };
  const readiness = { report: jest.fn(async () => ({ depositsEnabled: true, canCreateAccounts: true, ...o.readiness })) };
  const alerts = { raise: jest.fn(async () => true) };
  const notifications = { notify: jest.fn(async () => undefined) };
  const svc = new VirtualAccountsService(db as never, payrep, cfg as never, readiness as never, alerts as never, notifications as never);
  return { db, payrep, cfg, readiness, alerts, notifications, svc };
}

async function failure(p: Promise<unknown>): Promise<HttpException> {
  return (await p.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (e: unknown) => e,
  )) as HttpException;
}

/** Puts the user's request back in time, as if `ms` had passed. */
async function age(db: FakePrisma, ms: number) {
  const row = db.rows('virtualAccountRequest')[0];
  await db.virtualAccountRequest.update({ where: { userId: USER }, data: { stateSince: new Date((row.stateSince as Date).getTime() - ms) } });
}

describe('opening the account: create_account with the name on the ID, no identity number', () => {
  it('sends the ID name (first middle last) and our pool, records it, answers 201, and tells the customer', async () => {
    const { svc, db, payrep, notifications } = await setup();
    const create = jest.spyOn(payrep, 'createAccount');
    const res = await svc.openForUser(USER, {});
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ accountName: 'ADA CHIOMA OBI', poolAccountNumber: POOL });
    expect(res.httpStatus).toBe(201);
    expect(res.body).toEqual({ accountNumber: expect.stringMatching(/^\d{10}$/), accountName: 'DavoChain-ADA CHIOMA OBI', bankName: 'Payrep MFB', status: 'ACTIVE' });
    expect(db.rows('virtualAccount')).toEqual([
      expect.objectContaining({ userId: USER, provider: 'PAYREP', isPrimary: true, source: 'CREATED', identityType: null, providerStatus: 'active' }),
    ]);
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: USER, type: 'ngn_account.ready', title: 'Your naira account is ready' }));
    expect(db.rows('virtualAccountRequest')[0]).toMatchObject({ state: 'IDLE' });
  });

  it('a bvn or nin sent by an older app is ignored: never sent, never stored', async () => {
    const { svc, db, payrep } = await setup();
    const create = jest.spyOn(payrep, 'createAccount');
    await svc.openForUser(USER, { bvn: '22222223883', nin: '12345678901' } as never);
    expect(JSON.stringify(create.mock.calls)).not.toMatch(/22222223883|12345678901/);
    expect(JSON.stringify(db.rows('virtualAccount'))).not.toMatch(/22222223883|12345678901/);
  });

  it('no middle name: first and last; extra spaces tidied', async () => {
    const { svc, payrep } = await setup({ record: { recordFirstName: '  BOLA ', recordMiddleName: null, recordLastName: 'ADE  WALE ' } });
    const create = jest.spyOn(payrep, 'createAccount');
    await svc.openForUser(USER, {});
    expect(create).toHaveBeenCalledWith({ accountName: 'BOLA ADE WALE', poolAccountNumber: POOL });
  });

  it('no Dojah record (e.g. approved by hand): the name on the DavoChain account', async () => {
    const { svc, payrep } = await setup({ record: null });
    const create = jest.spyOn(payrep, 'createAccount');
    await svc.openForUser(USER, {});
    expect(create).toHaveBeenCalledWith({ accountName: 'Ada Obi', poolAccountNumber: POOL });
  });

  it('PAYREP_ACCOUNT_NAME_PREFIX is put in front when set (if live Payrep ever stops adding it)', async () => {
    const { svc, payrep } = await setup({ prefix: 'DavoChain-' });
    const create = jest.spyOn(payrep, 'createAccount');
    await svc.openForUser(USER, {});
    expect(create).toHaveBeenCalledWith({ accountName: 'DavoChain-ADA CHIOMA OBI', poolAccountNumber: POOL });
  });

  it('if the returned name has no "DavoChain" in it, owners are told once, and the account still works', async () => {
    const { svc, payrep, alerts } = await setup();
    jest.spyOn(payrep, 'createAccount').mockResolvedValueOnce({ accountNumber: '7356147005', accountName: 'ADA CHIOMA OBI', bankName: 'Payrep MFB', status: 'active', providerRef: null });
    const res = await svc.openForUser(USER, {});
    expect(res.httpStatus).toBe(201);
    expect(alerts.raise).toHaveBeenCalledWith('NAIRA_RAIL_CONFIG', 'payrep-account-name-prefix', expect.stringMatching(/DavoChain/), expect.any(Array), expect.any(Number));
  });

  it('hands back an existing account with 200 and asks Payrep only once', async () => {
    const { svc, payrep } = await setup();
    const create = jest.spyOn(payrep, 'createAccount');
    const first = await svc.openForUser(USER, {});
    const again = await svc.openForUser(USER, {});
    expect(again.httpStatus).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('a customer who may not have one: 403 NOT_ELIGIBLE, and Payrep is never asked', async () => {
    const { svc, payrep } = await setup({ user: { kycStatus: 'PENDING', kycTier: 'TIER_0' } });
    const create = jest.spyOn(payrep, 'createAccount');
    const e = await failure(svc.openForUser(USER, {}));
    expect(e.getStatus()).toBe(403);
    expect(e.getResponse()).toMatchObject({ code: 'NOT_ELIGIBLE' });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('when Payrep says no, is busy, or the answer is lost', () => {
  it('our setup refused (42/60): 503, owners alerted, the request goes idle', async () => {
    const { svc, payrep, alerts, db } = await setup();
    jest.spyOn(payrep, 'createAccount').mockRejectedValueOnce(new PayrepError('CONFIG', 'Pool account not found', 200, '42'));
    const e = await failure(svc.openForUser(USER, {}));
    expect(e.getStatus()).toBe(503);
    expect(alerts.raise).toHaveBeenCalledWith('NAIRA_RAIL_CONFIG', 'config', expect.any(String), expect.any(Array));
    expect(db.rows('virtualAccountRequest')[0]).toMatchObject({ state: 'IDLE' });
  });

  it('no main account set: 503 and an alert, without calling Payrep', async () => {
    const { svc, payrep, alerts } = await setup({ mainAccount: null });
    const create = jest.spyOn(payrep, 'createAccount');
    expect((await failure(svc.openForUser(USER, {}))).getStatus()).toBe(503);
    expect(create).not.toHaveBeenCalled();
    expect(alerts.raise).toHaveBeenCalled();
  });

  it('Payrep busy (nothing was sent): 503 "try later", the request goes idle, no alert', async () => {
    const { svc, payrep, alerts, db } = await setup();
    jest.spyOn(payrep, 'createAccount').mockRejectedValueOnce(new PayrepError('BUSY', 'paused', 429, '94'));
    expect((await failure(svc.openForUser(USER, {}))).getStatus()).toBe(503);
    expect(db.rows('virtualAccountRequest')[0]).toMatchObject({ state: 'IDLE' });
    expect(alerts.raise).not.toHaveBeenCalled();
  });

  it('a lost answer is 202 PENDING: UNKNOWN, owners alerted, nothing recorded, nothing sent again straight away', async () => {
    const { svc, payrep, alerts, db } = await setup();
    const create = jest.spyOn(payrep, 'createAccount').mockRejectedValueOnce(new PayrepError('UNCLEAR', 'socket hang up', 0, null));
    const res = await svc.openForUser(USER, {});
    expect(res).toEqual({ httpStatus: 202, body: { status: 'PENDING', message: expect.any(String) } });
    expect(db.rows('virtualAccount')).toEqual([]);
    expect(db.rows('virtualAccountRequest')[0]).toMatchObject({ state: 'UNKNOWN' });
    expect(alerts.raise).toHaveBeenCalledWith('VIRTUAL_ACCOUNT_SYNC', `va-unknown:${USER}`, expect.any(String), expect.any(Array), expect.any(Number));
    // Asked again a moment later: still waiting, and Payrep is not asked again.
    expect((await svc.openForUser(USER, {})).httpStatus).toBe(202);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('after a lost answer, the account Payrep DID open is found in its list and kept: no second account', async () => {
    const { svc, payrep, db } = await setup({ record: { recordFirstName: 'ANSWER', recordMiddleName: null, recordLastName: 'LOST' } });
    const create = jest.spyOn(payrep, 'createAccount');
    expect((await svc.openForUser(USER, {})).httpStatus).toBe(202); // the mock opens it, then "loses" the answer
    await age(db, 3 * MINUTE);
    const res = await svc.openForUser(USER, {});
    expect(res.httpStatus).toBe(201);
    expect(res.body).toMatchObject({ accountName: 'DavoChain-ANSWER LOST' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(db.rows('virtualAccount')).toHaveLength(1);
  });

  it('after a lost answer where nothing was opened, it is sent again (once)', async () => {
    const { svc, payrep, db } = await setup();
    const create = jest.spyOn(payrep, 'createAccount').mockRejectedValueOnce(new PayrepError('UNCLEAR', 'timeout', 0, null));
    await svc.openForUser(USER, {});
    await age(db, 3 * MINUTE);
    const res = await svc.openForUser(USER, {});
    expect(res.httpStatus).toBe(201);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("an account already recorded for another customer is never taken, even with the same name", async () => {
    const { svc, payrep, db } = await setup();
    jest.spyOn(payrep, 'createAccount').mockRejectedValueOnce(new PayrepError('UNCLEAR', 'timeout', 0, null));
    await svc.openForUser(USER, {});
    jest.spyOn(payrep, 'recentAccounts').mockResolvedValueOnce([{ accountNumber: '3046760427', accountName: 'DavoChain-ADA CHIOMA OBI', createdAt: new Date() }]);
    await db.virtualAccount.create({ data: { userId: OTHER_USER, provider: 'PAYREP', accountNumber: '3046760427', accountName: 'DavoChain-ADA CHIOMA OBI', bankName: 'Payrep MFB', isPrimary: true, source: 'CREATED' } });
    await age(db, 3 * MINUTE);
    const res = await svc.openForUser(USER, {});
    expect(res.httpStatus).toBe(201);
    expect((res.body as { accountNumber: string }).accountNumber).not.toBe('3046760427');
  });

  it('two possible accounts: never guess. A person is alerted, the customer waits, and after 24 hours a fresh one is opened', async () => {
    const { svc, payrep, db, alerts } = await setup();
    const create = jest.spyOn(payrep, 'createAccount').mockRejectedValueOnce(new PayrepError('UNCLEAR', 'timeout', 0, null));
    await svc.openForUser(USER, {});
    const now = new Date();
    jest.spyOn(payrep, 'recentAccounts').mockResolvedValueOnce([
      { accountNumber: '3046760427', accountName: 'DavoChain-ADA CHIOMA OBI', createdAt: now },
      { accountNumber: '7356147005', accountName: 'DavoChain-ADA CHIOMA OBI', createdAt: now },
    ]);
    await age(db, 3 * MINUTE);
    expect((await svc.openForUser(USER, {})).httpStatus).toBe(202);
    expect(db.rows('virtualAccountRequest')[0]).toMatchObject({ state: 'NEEDS_PERSON' });
    expect(alerts.raise).toHaveBeenCalledWith('VIRTUAL_ACCOUNT_SYNC', `va-ambiguous:${USER}`, expect.any(String), expect.arrayContaining([expect.stringMatching(/3046760427.*7356147005|7356147005.*3046760427/)]), expect.any(Number));
    expect((await svc.openForUser(USER, {})).httpStatus).toBe(202);
    expect(create).toHaveBeenCalledTimes(1);
    await age(db, 24 * 60 * MINUTE + MINUTE);
    expect((await svc.openForUser(USER, {})).httpStatus).toBe(201);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('the account list cannot be read: stay UNKNOWN and look again later; never send blind', async () => {
    const { svc, payrep, db } = await setup();
    const create = jest.spyOn(payrep, 'createAccount').mockRejectedValueOnce(new PayrepError('UNCLEAR', 'timeout', 0, null));
    await svc.openForUser(USER, {});
    jest.spyOn(payrep, 'recentAccounts').mockResolvedValueOnce(null);
    await age(db, 3 * MINUTE);
    expect((await svc.openForUser(USER, {})).httpStatus).toBe(202);
    expect(db.rows('virtualAccountRequest')[0]).toMatchObject({ state: 'UNKNOWN' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('opened but not recorded (database hiccup): 202 and an alert; the next try finds it in the list', async () => {
    const { svc, db, alerts, payrep } = await setup();
    const create = jest.spyOn(payrep, 'createAccount');
    db.failNext('virtualAccount', 'create', new Error('database unavailable'));
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    expect((await svc.openForUser(USER, {})).httpStatus).toBe(202);
    expect(alerts.raise).toHaveBeenCalledWith('VIRTUAL_ACCOUNT_SYNC', expect.stringMatching(/^va-unrecorded:/), expect.any(String), expect.any(Array), expect.any(Number));
    await age(db, 3 * MINUTE);
    expect((await svc.openForUser(USER, {})).httpStatus).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('one at a time, and a daily cap', () => {
  it('a second request while one is opening is 202 PENDING (not an error); a stale lock is taken over', async () => {
    const { svc, db } = await setup();
    await db.virtualAccountRequest.create({ data: { userId: USER, state: 'CREATING', stateSince: new Date(), attemptsInWindow: 1, windowStartedAt: new Date() } });
    expect((await svc.openForUser(USER, {})).httpStatus).toBe(202);
    await age(db, 3 * MINUTE);
    expect((await svc.openForUser(USER, {})).httpStatus).toBe(201);
  });

  it('five tries in 24 hours, then 429 for a tap (the background opener just waits)', async () => {
    const { svc, payrep, db } = await setup();
    jest.spyOn(payrep, 'createAccount').mockRejectedValue(new PayrepError('BUSY', 'paused', 429, '94'));
    for (let i = 0; i < 5; i++) await failure(svc.openForUser(USER, {}));
    const e = await failure(svc.openForUser(USER, {}));
    expect(e.getStatus()).toBe(429);
    expect((await svc.ensure(USER, 'AUTO')).httpStatus).toBe(202);
    expect(db.rows('virtualAccountRequest')[0]).toMatchObject({ attemptsInWindow: 5 });
  });
});

describe('reading the account: GET opens it for an eligible customer', () => {
  it('eligible and none yet: GET opens it there and then (200); later GETs just read it', async () => {
    const { svc, payrep } = await setup();
    const create = jest.spyOn(payrep, 'createAccount');
    const r = await svc.getForUser(USER);
    expect(r.httpStatus).toBe(200);
    expect(r.body).toMatchObject({ accountNumber: expect.stringMatching(/^\d{10}$/), status: 'ACTIVE' });
    await svc.getForUser(USER);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('while it is being opened, GET is 202 PENDING', async () => {
    const { svc, db } = await setup();
    await db.virtualAccountRequest.create({ data: { userId: USER, state: 'CREATING', stateSince: new Date(), attemptsInWindow: 1, windowStartedAt: new Date() } });
    expect(await svc.getForUser(USER)).toEqual({ httpStatus: 202, body: { status: 'PENDING', message: expect.any(String) } });
  });

  it('not eligible: 404 NO_VIRTUAL_ACCOUNT with the reason, and Payrep is never asked', async () => {
    const { svc, payrep } = await setup({ user: { kycStatus: 'NOT_STARTED', kycTier: 'TIER_0' } });
    const create = jest.spyOn(payrep, 'createAccount');
    const e = await failure(svc.getForUser(USER));
    expect(e.getStatus()).toBe(404);
    expect(e.getResponse()).toMatchObject({ code: 'NO_VIRTUAL_ACCOUNT', eligible: false, reason: expect.stringMatching(/Verify/) });
    expect(create).not.toHaveBeenCalled();
  });

  it('a Payrep problem on GET never shows as an error: 202 PENDING, and the background opener retries', async () => {
    const { svc, payrep } = await setup();
    jest.spyOn(payrep, 'createAccount').mockRejectedValueOnce(new PayrepError('BUSY', 'paused', 429, '94'));
    expect((await svc.getForUser(USER)).httpStatus).toBe(202);
  });

  it('shows INACTIVE when switched off', async () => {
    const { svc, db } = await setup();
    await svc.openForUser(USER, {});
    await db.virtualAccount.updateMany({ where: { userId: USER }, data: { desiredStatus: 'INACTIVE' } });
    expect((await svc.getForUser(USER)).body).toMatchObject({ status: 'INACTIVE' });
  });
});

describe('owners and "off" (unchanged)', () => {
  it('findOwnerByAccount knows switched-off accounts', async () => {
    const { svc } = await setup();
    await svc.openForUser(USER, {});
    const [va] = await svc.listForUser(USER);
    await expect(svc.findOwnerByAccount(va.accountNumber)).resolves.toEqual({ userId: USER, switchedOff: false });
    await svc.setDesiredForUser(USER, 'INACTIVE');
    await expect(svc.findOwnerByAccount(va.accountNumber)).resolves.toEqual({ userId: USER, switchedOff: true });
    await expect(svc.findOwnerByAccount('0000000000')).resolves.toBeNull();
  });

  it('setDesiredForUser only records the wish and never throws', async () => {
    const { svc, db, payrep } = await setup();
    await svc.openForUser(USER, {});
    const calls = jest.spyOn(payrep, 'createAccount');
    await svc.setDesiredForUser(USER, 'INACTIVE', { background: true });
    expect(db.rows('virtualAccount')[0]).toMatchObject({ desiredStatus: 'INACTIVE' });
    expect(calls).not.toHaveBeenCalled();
    db.failNext('virtualAccount', 'updateMany', new Error('database unavailable'));
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(svc.setDesiredForUser(USER, 'ACTIVE')).resolves.toBeUndefined();
  });

  it("lets an admin switch one account, refusing another user's with 404", async () => {
    const { svc, db } = await setup();
    await svc.openForUser(USER, {});
    const vaId = db.rows('virtualAccount')[0].id as string;
    expect((await failure(svc.setDesired('someone-else', vaId, 'INACTIVE'))).getStatus()).toBe(404);
    const { before, after } = await svc.setDesired(USER, vaId, 'INACTIVE');
    expect(before).toMatchObject({ id: vaId, desiredStatus: 'ACTIVE' });
    expect(after).toMatchObject({ id: vaId, desiredStatus: 'INACTIVE' });
  });
});

describe('final review C1: a person not AML-CLEAR cannot have a naira deposit account', () => {
  it.each(['BLOCKED', 'UNDER_REVIEW', 'RESTRICTED', 'PENDING', 'NOT_SCREENED'])('%s is not eligible, with the generic wording', async (amlStatus) => {
    const { svc } = await setup({ user: { amlStatus } });
    const r = await svc.eligibility(USER);
    expect(r.eligible).toBe(false);
    expect(r.reason).not.toMatch(/sanction|aml|pep|blocked/i);
  });
});
