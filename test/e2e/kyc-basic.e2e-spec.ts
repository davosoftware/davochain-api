import { ADDRESS, call, idNumber, login, newUser, requireServer, verifyBasic } from './helpers';

beforeAll(requireServer);

const submit = (token: string, over: Record<string, unknown> = {}) =>
  call('POST', '/kyc/basic', {
    token,
    body: {
      idType: 'BVN',
      idNumber: idNumber('333'),
      firstName: 'Someone',
      lastName: 'Clean',
      dateOfBirth: '1995-03-03',
      address: ADDRESS,
      stateOfOrigin: 'Lagos',
      country: 'NG',
      ...over,
    },
  });

describe('KYC status (GET /v1/kyc)', () => {
  it('a new user is NONE, with 3 attempts today and 10 in total', async () => {
    const u = await newUser();
    const r = await call('GET', '/kyc', { token: u.token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ tier: 'TIER_0', status: 'NOT_STARTED', level: 'NONE', basicState: null, underReview: false, attemptsLeftToday: 3, attemptsLeftTotal: 10 });
  });

  it('never exposes AML details to the user', async () => {
    const u = await newUser();
    const r = await call('GET', '/kyc', { token: u.token });
    expect(JSON.stringify(r.body)).not.toMatch(/aml|sanction|pep/i);
  });
});

describe('the KYC gate on money routes', () => {
  it('an unverified user asking for a quote gets 403 with requiredTier', async () => {
    const u = await newUser();
    const r = await call('POST', '/quotes', { token: u.token, body: { side: 'buy', fromAsset: 'ngn', toAsset: 'btc', amount: '50000' } });
    expect(r.status).toBe(403);
    // Level policy (15 Oct 2026): the admin's rules answer; requiredTier stays for older app builds.
    expect(r.body).toMatchObject({ code: 'NOT_ALLOWED_AT_LEVEL', action: 'BUY', currentLevel: 'NONE', requiredLevel: 'BASIC', requiredTier: 'TIER_1', currentTier: 'TIER_0', message: 'Complete Basic verification to buy crypto.' });
  });
});

describe('Basic verification (POST /v1/kyc/basic) on the Dojah mock', () => {
  it('the clean test identity is approved at once, and the user becomes Basic after signing in again', async () => {
    const u = await newUser();
    const raw = idNumber('333');
    const r = await submit(u.token, { idNumber: raw });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ state: 'APPROVED', level: 'BASIC', message: 'You are verified.' });
    const fresh = await login(u);
    const k = await call('GET', '/kyc', { token: fresh.token });
    expect(k.body).toMatchObject({ tier: 'TIER_1', status: 'APPROVED', level: 'BASIC', basicState: 'APPROVED', bvnLast4: raw.slice(-4) });
  });

  it('GET /v1/me shows the verified date of birth after Basic, and null before (28 Oct 2026)', async () => {
    const before = await newUser();
    expect((await call('GET', '/me', { token: before.token })).body.dateOfBirth).toBeNull();
    const after = await verifyBasic(await newUser());
    expect((await call('GET', '/me', { token: after.token })).body.dateOfBirth).toBe('1995-03-03');
  });

  it('the raw BVN never comes back in any response', async () => {
    const u = await newUser();
    const raw = idNumber('333');
    const r = await submit(u.token, { idNumber: raw });
    const k = await call('GET', '/kyc', { token: (await login(u)).token });
    expect(JSON.stringify([r.body, k.body])).not.toContain(raw);
  });

  it('approval ends the old session: the pre-approval refresh token stops working', async () => {
    const u = await newUser();
    await submit(u.token);
    const r = await call('POST', '/auth/refresh', { body: { refreshToken: u.refreshToken } });
    expect(r.status).toBe(401);
  });

  it('an already verified user is 409', async () => {
    const u = await verifyBasic(await newUser());
    const r = await submit(u.token);
    expect(r.status).toBe(409);
    expect(r.body.message).toBe('You are already verified.');
  });

  it('a number Dojah cannot find is rejected, and uses an attempt', async () => {
    const u = await newUser();
    const r = await submit(u.token, { idNumber: '11111111111' });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ state: 'REJECTED_NOT_FOUND', level: 'NONE', message: 'We could not find that BVN/NIN. Check the number and try again.' });
    const k = await call('GET', '/kyc', { token: u.token });
    expect(k.body).toMatchObject({ attemptsLeftToday: 2, attemptsLeftTotal: 9, status: 'REJECTED' });
  });

  it('a name that does not match goes to a person, with a generic message, and blocks a second submit', async () => {
    const u = await newUser();
    const r = await submit(u.token, { firstName: 'Wrong', lastName: 'Person' });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ state: 'IDENTITY_REVIEW', level: 'NONE', message: 'We are reviewing your details. We will email you when it is done.' });
    const k = await call('GET', '/kyc', { token: u.token });
    expect(k.body).toMatchObject({ underReview: true, basicState: 'IDENTITY_REVIEW' });
    const again = await submit(u.token);
    expect(again.status).toBe(409);
    expect(again.body.message).toBe('A verification is already in progress.');
  });

  it('a provider failure is 503 and does NOT use an attempt', async () => {
    const u = await newUser();
    const r = await submit(u.token, { idNumber: '40200000001' });
    expect(r.status).toBe(503);
    expect(r.body.message).toBe('Verification is temporarily unavailable. Please try again later.');
    const k = await call('GET', '/kyc', { token: u.token });
    expect(k.body).toMatchObject({ attemptsLeftToday: 3, attemptsLeftTotal: 10 });
  });

  it('an AML hit (PEP) goes to compliance review, and money routes answer "under review" without saying why', async () => {
    const u = await newUser();
    const r = await submit(u.token, { idNumber: idNumber('222'), firstName: 'John', middleName: 'Doe', lastName: 'Ajayi', dateOfBirth: '2000-05-01' });
    expect(r.status).toBe(201);
    expect(r.body.state).toBe('COMPLIANCE_REVIEW');
    const q = await call('POST', '/quotes', { token: u.token, body: { side: 'buy', fromAsset: 'ngn', toAsset: 'btc', amount: '50000' } });
    expect(q.status).toBe(403);
    expect(q.body).toEqual({ code: 'ACCOUNT_UNDER_REVIEW', message: 'Your account is under review. Contact support.' });
  });

  it('a confirmed sanctions match blocks the account and ends its sessions', async () => {
    const u = await newUser();
    const r = await submit(u.token, { idNumber: idNumber('666'), firstName: 'Test', lastName: 'Sanctioned', dateOfBirth: '1985-06-06' });
    expect(r.status).toBe(201);
    expect(r.body.state).toBe('COMPLIANCE_REVIEW');
    expect((await call('POST', '/auth/refresh', { body: { refreshToken: u.refreshToken } })).status).toBe(401);
    // Signing in still works (no tipping off); money routes do not.
    const fresh = await login(u);
    const q = await call('POST', '/quotes', { token: fresh.token, body: { side: 'buy', fromAsset: 'ngn', toAsset: 'btc', amount: '50000' } });
    expect(q.status).toBe(403);
    expect(q.body.code).toBe('ACCOUNT_UNDER_REVIEW');
    // ...and a blocked person cannot start another verification.
    const again = await submit(fresh.token);
    expect(again.status).toBe(403);
  });
});

describe('Basic verification: invalid input (all 400, before any Dojah call)', () => {
  it.each([
    ['a 10-digit number', { idNumber: '1234567890' }, 'BVN and NIN are 11 digits'],
    ['letters in the number', { idNumber: '2222222222a' }, 'BVN and NIN are 11 digits'],
    ['a date in the wrong format', { dateOfBirth: '01/05/2000' }, 'Use YYYY-MM-DD'],
  ])('%s', async (_label, over, message) => {
    const u = await newUser();
    const r = await submit(u.token, over);
    expect(r.status).toBe(400);
    expect(r.body.message).toEqual(expect.arrayContaining([message]));
  });

  it('an LGA from another state', async () => {
    const u = await newUser();
    const r = await submit(u.token, { address: { ...ADDRESS, lga: 'Nsukka' } });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('Choose your state and LGA from the list');
  });

  it('a made-up state of origin', async () => {
    const u = await newUser();
    const r = await submit(u.token, { stateOfOrigin: 'Atlantis' });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('Choose your state of origin from the list');
  });

  it('a country other than NG', async () => {
    const u = await newUser();
    const r = await submit(u.token, { country: 'GH' });
    expect(r.status).toBe(400);
  });

  it('none of these used an attempt', async () => {
    const u = await newUser();
    await submit(u.token, { idNumber: '123' });
    await submit(u.token, { stateOfOrigin: 'Atlantis' });
    const k = await call('GET', '/kyc', { token: u.token });
    expect(k.body).toMatchObject({ attemptsLeftToday: 3, attemptsLeftTotal: 10 });
  });
});

describe('one BVN/NIN verifies one account (H8)', () => {
  it('a second account with the same BVN is refused, before any lookup', async () => {
    const raw = idNumber('333');
    const first = await newUser();
    expect((await submit(first.token, { idNumber: raw })).body.state).toBe('APPROVED');
    const second = await newUser();
    const r = await submit(second.token, { idNumber: raw });
    expect(r.status).toBe(409);
    expect(r.body.message).toBe('This BVN/NIN is already linked to another DavoChain account. Contact support.');
    const k = await call('GET', '/kyc', { token: second.token });
    expect(k.body).toMatchObject({ attemptsLeftToday: 3, attemptsLeftTotal: 10 });
  });
});
