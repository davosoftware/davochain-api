import { ADDRESS, call, idNumber, newUser, requireServer, verifyEmail } from './helpers';

beforeAll(requireServer);

/** H9 "verify before money" (plan 2026-10-22 Task 5). */
describe('confirm email before money (H9)', () => {
  const basic = (token: string) =>
    call('POST', '/kyc/basic', {
      token,
      body: { idType: 'BVN', idNumber: idNumber('333'), firstName: 'Someone', lastName: 'Clean', dateOfBirth: '1995-03-03', address: ADDRESS, stateOfOrigin: 'Lagos', country: 'NG' },
    });

  it('an unconfirmed user is refused verification and a deposit account, can ask for a code, and is let in once confirmed', async () => {
    const u = await newUser('Email', 'Gate', { verifyEmail: false });

    const kyc = await basic(u.token);
    expect(kyc.status).toBe(403);
    expect(kyc.body).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    expect(kyc.body.message).toMatch(/^Confirm your email address first\. We sent a code to e\*+@davochain\.invalid\.$/);

    const account = await call('POST', '/deposits/ngn/account', { token: u.token, body: {} });
    expect(account.status).toBe(403);
    expect(account.body).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });

    const quote = await call('POST', '/quotes', { token: u.token, body: { side: 'buy', fromAsset: 'ngn', toAsset: 'btc', amount: '50000' } });
    expect(quote.status).toBe(403);
    expect(quote.body).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });

    const send = await call('POST', '/auth/email/send-code', { token: u.token });
    expect(send.status).toBe(200);
    expect(send.body).toMatchObject({ sent: true });

    expect((await call('GET', '/me', { token: u.token })).body).toMatchObject({ emailVerified: false });

    verifyEmail(u);
    expect((await call('GET', '/me', { token: u.token })).body).toMatchObject({ emailVerified: true });
    const again = await basic(u.token);
    expect(again.status).toBe(201);
  });

  it('a wrong code is refused with tries left, and the routes that are not money stay open', async () => {
    const u = await newUser('Email', 'Wrong', { verifyEmail: false });
    await call('POST', '/auth/email/send-code', { token: u.token });
    const r = await call('POST', '/auth/email/verify', { token: u.token, body: { code: '000000' } });
    // 1 in a million the random code is 000000; then it simply confirms.
    if (r.status !== 200) {
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/tries left/);
    }
    expect((await call('GET', '/wallets', { token: u.token })).status).toBe(200);
    expect((await call('GET', '/kyc', { token: u.token })).status).toBe(200);
  });

  it('a malformed code is refused by validation', async () => {
    const u = await newUser('Email', 'Bad', { verifyEmail: false });
    const r = await call('POST', '/auth/email/verify', { token: u.token, body: { code: '12ab' } });
    expect(r.status).toBe(400);
  });
});
