import { FakePrisma } from '../ngn-deposits/testing/fake-prisma';
import { DojahMockClient } from '../dojah/dojah.mock';
import { DojahError } from '../dojah/dojah.errors';
import { AmlService } from './aml.service';

const identity = (last: string) => ({ usable: true, firstName: 'John', middleName: 'Doe', lastName: last, dateOfBirth: '2000-05-01', gender: 'MALE' as const, customerRef: null });

async function setup(last = 'Clean') {
  const db = new FakePrisma();
  const dojah = new DojahMockClient();
  const alerts = { raise: jest.fn(async (..._a: unknown[]) => true) };
  const va = { setDesiredForUser: jest.fn(async (..._a: unknown[]) => undefined) };
  const svc = new AmlService(db as never, dojah, alerts as never, va as never);
  const approvals: string[] = [];
  svc.setApprovalHook(async (_tx, verificationId) => {
    approvals.push(verificationId);
    return [];
  });
  await db.user.create({ data: { id: 'u1', email: 'u1@x.test', firstName: 'John', lastName: last } });
  const inputs = svc.amlInputs(identity(last))!;
  const s = await svc.startScreening(db as never, 'u1', inputs);
  await db.kycVerification.create({ data: { id: 'v1', userId: 'u1', activeFor: 'u1', state: 'LOOKED_UP', lagosDay: '2026-10-14', idType: 'BVN', idHash: 'h1:x', idLast4: '2222', typedFirstName: 'John', typedLastName: last, typedDateOfBirth: '2000-05-01', typedAddress: {}, screeningId: s.id } });
  return { db, dojah, alerts, va, svc, screeningId: s.id, approvals };
}

describe('AmlService', () => {
  it('builds inputs from verified data only, with no id number (spec §14.3)', async () => {
    const { svc } = await setup();
    expect(svc.amlInputs(identity('Clean'))).toEqual({ names: 'John Doe Clean', date_of_birth: '2000-05-01', gender: 'Male', nationality: 'NG' });
    expect(svc.amlInputs({ ...identity('Clean'), gender: 'UNKNOWN' })).not.toHaveProperty('gender');
    expect(svc.amlInputs({ ...identity('Clean'), dateOfBirth: null })).not.toHaveProperty('date_of_birth');
    expect(svc.amlInputs({ ...identity('Clean'), lastName: null })).toBeNull();
  });

  it('moves NOT_SCREENED to PENDING when a screening starts', async () => {
    const { db } = await setup();
    expect(db.rows('user')[0].amlStatus).toBe('PENDING');
  });

  it('reuses a screening with the same inputs instead of buying another', async () => {
    const { db, svc } = await setup();
    const again = await svc.startScreening(db as never, 'u1', svc.amlInputs(identity('Clean'))!);
    expect(again.reused).toBe(true);
    expect(db.rows('amlScreening')).toHaveLength(1);
  });

  it('CLEAR: records entity_id, user CLEAR, verification handed to the approval hook, no case', async () => {
    const { db, svc, screeningId, approvals } = await setup('Clean');
    await svc.send(screeningId);
    expect(db.rows('amlScreening')[0]).toMatchObject({ status: 'CLEAR', entityId: 'mock-clear', callOutcome: 'SUCCEEDED', sendCount: 1 });
    expect(db.rows('user')[0].amlStatus).toBe('CLEAR');
    expect(approvals).toEqual(['v1']);
    expect(db.rows('amlReviewCase')).toHaveLength(0);
  });

  it('the sandbox "Unknown" + PEP answer is never clear: case, UNDER_REVIEW, AML_REVIEW alert', async () => {
    const { db, svc, screeningId, alerts, approvals } = await setup('Ajayi');
    await svc.send(screeningId);
    expect(db.rows('amlScreening')[0].status).toBe('UNKNOWN');
    expect(db.rows('user')[0].amlStatus).toBe('UNDER_REVIEW');
    expect(db.rows('kycVerification')[0].state).toBe('COMPLIANCE_REVIEW');
    expect(db.rows('amlReviewCase')[0]).toMatchObject({ category: 'PEP', priority: 'HIGH', status: 'OPEN' });
    expect(alerts.raise).toHaveBeenCalledWith('AML_REVIEW', expect.stringMatching(/^case:/), expect.any(String), expect.any(Array), 0);
    expect(approvals).toEqual([]);
  });

  it('confirmed sanctions: BLOCKED, tokens revoked, CRITICAL case, deposit account off, alert without the name', async () => {
    const { db, svc, screeningId, alerts, va } = await setup('Sanctioned');
    await db.refreshToken.create({ data: { userId: 'u1', revokedAt: null } });
    await svc.send(screeningId);
    expect(db.rows('user')[0].amlStatus).toBe('BLOCKED');
    expect(db.rows('refreshToken')[0].revokedAt).toBeInstanceOf(Date);
    expect(db.rows('amlReviewCase')[0]).toMatchObject({ category: 'SANCTIONS', priority: 'CRITICAL', possible: false });
    expect(va.setDesiredForUser).toHaveBeenCalledWith('u1', 'INACTIVE', { background: true });
    const [type, , subject, lines] = alerts.raise.mock.calls[0] as unknown as [string, string, string, string[]];
    expect(type).toBe('AML_SANCTIONS');
    expect(subject + lines.join(' ')).not.toMatch(/John|Sanctioned/);
    expect(db.rows('adminAuditLog')[0]).toMatchObject({ action: 'aml.auto_block', adminUserId: '00000000-0000-0000-0000-000000000001' });
  });

  it('possible sanctions: UNDER_REVIEW (not blocked), CRITICAL case flagged possible', async () => {
    const { db, svc, screeningId } = await setup('Maybesanctioned');
    await svc.send(screeningId);
    expect(db.rows('user')[0].amlStatus).toBe('UNDER_REVIEW');
    expect(db.rows('amlReviewCase')[0]).toMatchObject({ category: 'SANCTIONS', possible: true, priority: 'CRITICAL' });
  });

  it('a definite failure schedules a free retry at +2 min and keeps the user PENDING', async () => {
    const { db, svc, screeningId, dojah } = await setup('Clean');
    jest.spyOn(dojah, 'screen').mockRejectedValueOnce(new DojahError('SERVER', 'x', 500));
    const before = Date.now();
    await svc.send(screeningId);
    const s = db.rows('amlScreening')[0];
    expect(s).toMatchObject({ status: 'PENDING', callOutcome: 'DEFINITELY_FAILED', definiteFailCount: 1 });
    expect((s.nextAttemptAt as Date).getTime()).toBeGreaterThanOrEqual(before + 120_000);
    expect(db.rows('user')[0].amlStatus).toBe('PENDING');
  });

  it('after 1 + 3 definite failures it stops: ERROR case, UNDER_REVIEW (spec §8.3)', async () => {
    const { db, svc, screeningId, dojah } = await setup('Clean');
    jest.spyOn(dojah, 'screen').mockRejectedValue(new DojahError('SERVER', 'x', 500));
    for (let i = 0; i < 4; i++) {
      await db.amlScreening.updateMany({ where: { id: screeningId }, data: { nextAttemptAt: null } });
      await svc.send(screeningId);
    }
    expect(db.rows('amlScreening')[0]).toMatchObject({ status: 'ERROR', definiteFailCount: 4, sendCount: 4 });
    expect(db.rows('amlReviewCase')[0]).toMatchObject({ category: 'ERROR' });
    expect(db.rows('user')[0].amlStatus).toBe('UNDER_REVIEW');
    expect(db.rows('kycVerification')[0].state).toBe('COMPLIANCE_REVIEW');
  });

  it('UNKNOWN: re-sent once after the lease, flagged as a possible duplicate charge; a second UNKNOWN stops (plan §R1.3)', async () => {
    const { db, svc, screeningId, dojah } = await setup('Clean');
    const spy = jest.spyOn(dojah, 'screen').mockRejectedValue(new DojahError('UNKNOWN', 'timeout', 0));
    await svc.send(screeningId);
    let s = db.rows('amlScreening')[0];
    expect(s).toMatchObject({ status: 'PENDING', callOutcome: 'UNKNOWN', unknownCount: 1 });
    expect((s.nextAttemptAt as Date).getTime() - (s.screenStartedAt as Date).getTime()).toBeGreaterThanOrEqual(300_000);

    await svc.send(screeningId); // too early: refused, nothing sent
    expect(spy).toHaveBeenCalledTimes(1);

    await db.amlScreening.updateMany({ where: { id: screeningId }, data: { nextAttemptAt: new Date(0) } });
    await svc.send(screeningId);
    s = db.rows('amlScreening')[0];
    expect(spy).toHaveBeenCalledTimes(2);
    expect(s).toMatchObject({ status: 'ERROR', unknownCount: 2, possibleDuplicateCharge: true });

    await svc.send(screeningId); // nothing more, ever
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a send that loses its claim to another worker makes no call', async () => {
    const { db, svc, screeningId, dojah } = await setup('Clean');
    await db.amlScreening.updateMany({ where: { id: screeningId }, data: { callOutcome: 'IN_FLIGHT', screenStartedAt: new Date(), sendCount: 1 } });
    const spy = jest.spyOn(dojah, 'screen');
    await svc.send(screeningId);
    expect(spy).not.toHaveBeenCalled();
  });

  it('markStaleInFlight turns an IN_FLIGHT older than 5 minutes into UNKNOWN and schedules the one re-send', async () => {
    const { db, svc, screeningId } = await setup('Clean');
    await db.amlScreening.updateMany({ where: { id: screeningId }, data: { callOutcome: 'IN_FLIGHT', screenStartedAt: new Date(Date.now() - 301_000), sendCount: 1 } });
    expect(await svc.markStaleInFlight()).toBe(1);
    expect(db.rows('amlScreening')[0]).toMatchObject({ callOutcome: 'UNKNOWN', unknownCount: 1, status: 'PENDING' });
    expect(await svc.dueRetries()).toEqual([screeningId]);
  });

  it('a case is opened at most once per screening, even if finalise runs twice', async () => {
    const { db, svc, screeningId } = await setup('Pep');
    await svc.send(screeningId);
    await db.$transaction((tx) => svc.finalise(tx as never, screeningId));
    expect(db.rows('amlReviewCase')).toHaveLength(1);
  });

  it('a DOJAH_CONFIG alert for 401/402/403, hourly', async () => {
    const { svc, screeningId, dojah, alerts } = await setup('Clean');
    jest.spyOn(dojah, 'screen').mockRejectedValueOnce(new DojahError('WALLET', 'empty', 402));
    await svc.send(screeningId);
    expect(alerts.raise).toHaveBeenCalledWith('DOJAH_CONFIG', 'dojah:WALLET', expect.any(String), expect.any(Array));
  });
});

it('a re-screen result updates the ERROR case (category, rescreenResult) but never closes it', async () => {
  const db = new FakePrisma();
  const dojah = new DojahMockClient();
  const svc = new AmlService(db as never, dojah, { raise: jest.fn(async () => true) } as never, { setDesiredForUser: jest.fn() } as never);
  await db.user.create({ data: { id: 'u1', email: 'u1@x.test', firstName: 'John', lastName: 'Pep', amlStatus: 'UNDER_REVIEW' } });
  const s = await db.amlScreening.create({ data: { userId: 'u1', inputs: { names: 'John Pep', nationality: 'NG' }, inputFingerprint: 'f', status: 'ERROR' } });
  await db.$transaction((tx) => svc.finalise(tx as never, s.id as string)); // opens the ERROR case
  expect(db.rows('amlReviewCase')[0]).toMatchObject({ category: 'ERROR' });
  await db.amlScreening.updateMany({ where: { id: s.id }, data: { status: 'PENDING', callOutcome: null, unknownCount: 0, definiteFailCount: 0 } });
  await svc.send(s.id as string);
  expect(db.rows('amlReviewCase')).toHaveLength(1);
  expect(db.rows('amlReviewCase')[0]).toMatchObject({ category: 'PEP', rescreenResult: 'POSSIBLE_MATCH', status: 'OPEN', priority: 'HIGH' });
  expect(db.rows('user')[0].amlStatus).toBe('UNDER_REVIEW');
});

it('a CLEAR re-screen on an ERROR case records the result but never clears the person', async () => {
  const db = new FakePrisma();
  const dojah = new DojahMockClient();
  const svc = new AmlService(db as never, dojah, { raise: jest.fn(async () => true) } as never, { setDesiredForUser: jest.fn() } as never);
  await db.user.create({ data: { id: 'u1', email: 'u1@x.test', firstName: 'John', lastName: 'Clean', amlStatus: 'UNDER_REVIEW' } });
  const s = await db.amlScreening.create({ data: { userId: 'u1', inputs: { names: 'John Clean', nationality: 'NG' }, inputFingerprint: 'f', status: 'ERROR' } });
  await db.$transaction((tx) => svc.finalise(tx as never, s.id as string));
  await db.amlScreening.updateMany({ where: { id: s.id }, data: { status: 'PENDING', callOutcome: null, unknownCount: 0, definiteFailCount: 0 } });
  await svc.send(s.id as string);
  expect(db.rows('amlReviewCase')[0]).toMatchObject({ category: 'ERROR', rescreenResult: 'CLEAR', status: 'OPEN' });
  expect(db.rows('user')[0].amlStatus).toBe('UNDER_REVIEW');
});

it('a confirmed sanctions re-screen blocks a person under review (plan ruling 5)', async () => {
  const db = new FakePrisma();
  const dojah = new DojahMockClient();
  const svc = new AmlService(db as never, dojah, { raise: jest.fn(async () => true) } as never, { setDesiredForUser: jest.fn(async () => undefined) } as never);
  await db.user.create({ data: { id: 'u1', email: 'u1@x.test', firstName: 'A', lastName: 'Sanctioned', amlStatus: 'UNDER_REVIEW' } });
  const s = await db.amlScreening.create({ data: { userId: 'u1', inputs: { names: 'A Sanctioned', nationality: 'NG' }, inputFingerprint: 'f', status: 'ERROR' } });
  await db.$transaction((tx) => svc.finalise(tx as never, s.id as string));
  await db.amlScreening.updateMany({ where: { id: s.id }, data: { status: 'PENDING', callOutcome: null, unknownCount: 0, definiteFailCount: 0 } });
  await svc.send(s.id as string);
  expect(db.rows('user')[0].amlStatus).toBe('BLOCKED');
  expect(db.rows('amlReviewCase')[0]).toMatchObject({ category: 'SANCTIONS', priority: 'CRITICAL', rescreenResult: 'CONFIRMED_MATCH' });
});
