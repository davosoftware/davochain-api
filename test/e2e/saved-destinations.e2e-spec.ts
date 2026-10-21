import { adminToken, call, hasAdmin, key, newUser, requireServer, verifyBasic, type TestUser } from './helpers';

/**
 * Saved withdrawal destinations (Part 2, C6), over real HTTP: withdrawals go
 * only to an account or address the customer saved with their password.
 * The naira rail's mock (Payrep) knows bank "000014" (Access Bank) and names every account
 * "MOCK ACCOUNT <last 4>".
 */
let user: TestUser;

beforeAll(async () => {
  await requireServer();
  user = await verifyBasic(await newUser());
});

const addBank = (body: Record<string, unknown>) => call('POST', '/me/bank-accounts', { token: user.token, body });

describe('saved bank accounts', () => {
  let savedId: string;

  it('a wrong password saves nothing (401)', async () => {
    const r = await addBank({ bankCode: '000014', accountNumber: '0123456789', password: 'Not-my-password-1' });
    expect(r.status).toBe(401);
    expect(r.body.message).toBe('Incorrect password');
  });

  it('saves with the bank\'s name, masked, and lists it', async () => {
    const r = await addBank({ bankCode: '000014', accountNumber: '0123456789', nickname: 'Main', password: user.password });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ bankName: 'Access Bank', accountNumberMasked: '******6789', accountName: 'MOCK ACCOUNT 6789', nickname: 'Main', usableNow: true });
    expect(r.body).not.toHaveProperty('accountNumber');
    savedId = r.body.id;
    const list = await call('GET', '/me/bank-accounts', { token: user.token });
    expect(list.status).toBe(200);
    expect(list.body.max).toBeGreaterThanOrEqual(1);
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([savedId]);
  });

  it('the same account twice is refused', async () => {
    const r = await addBank({ bankCode: '000014', accountNumber: '0123456789', password: user.password });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('This account is already saved.');
  });

  it('typed bank details at withdrawal are refused: choose a saved account', async () => {
    const r = await call('POST', '/withdrawals/ngn', {
      token: user.token,
      body: { amount: '1000', accountNumber: '0123456789', bankCode: '000014' },
      headers: { 'Idempotency-Key': key() },
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body.message)).toContain('Choose a saved bank account');
  });

  it('removed: gone from the list, and a withdrawal to it is 404', async () => {
    const del = await call('DELETE', `/me/bank-accounts/${savedId}`, { token: user.token });
    expect(del.status).toBe(200);
    expect((await call('GET', '/me/bank-accounts', { token: user.token })).body.items).toEqual([]);
    const w = await call('POST', '/withdrawals/ngn', {
      token: user.token,
      body: { amount: '1000', savedBankAccountId: savedId },
      headers: { 'Idempotency-Key': key() },
    });
    expect(w.status).toBe(404);
    expect(w.body.message).toBe('Saved account not found');
  });

  it('someone else cannot see or remove it', async () => {
    const other = await newUser();
    expect((await call('GET', '/me/bank-accounts', { token: other.token })).body.items).toEqual([]);
    expect((await call('DELETE', `/me/bank-accounts/${savedId}`, { token: other.token })).status).toBe(404);
  });
});

const describeAdmin = hasAdmin ? describe : describe.skip;

describeAdmin('a new address waits out the admin\'s cool-off', () => {
  let ADMIN: string;
  let original: { rules: unknown[]; cooloffs: Array<Record<string, unknown>>; platform: unknown };

  beforeAll(async () => {
    ADMIN = (await adminToken())!;
    original = (await call('GET', '/admin/levels', { token: ADMIN })).body;
  });

  afterAll(async () => {
    if (original) await call('PUT', '/admin/levels', { token: ADMIN, body: { rules: original.rules, cooloffs: original.cooloffs, platform: original.platform } });
  });

  it('with a 1-hour wait, a just-saved address is refused with DESTINATION_COOLING_OFF', async () => {
    const cooloffs = original.cooloffs.map((c) => (c.level === 'BASIC' ? { ...c, afterNewPayeeHours: 1 } : c));
    const put = await call('PUT', '/admin/levels', { token: ADMIN, body: { rules: original.rules, cooloffs, platform: original.platform } });
    expect(put.status).toBe(200);

    const add = await call('POST', '/me/crypto-addresses', {
      token: user.token,
      body: { asset: 'usdt', network: 'erc20', address: '0x52908400098527886E0F7030069857D2E4169EE7', password: user.password },
    });
    expect(add.status).toBe(201);
    expect(add.body.usableNow).toBe(false);

    const w = await call('POST', '/withdrawals/crypto', {
      token: user.token,
      body: { amount: '1', savedCryptoAddressId: add.body.id },
      headers: { 'Idempotency-Key': key() },
    });
    expect(w.status).toBe(403);
    expect(w.body).toMatchObject({ code: 'DESTINATION_COOLING_OFF' });
    expect(w.body.message).toMatch(/^This address can be used from \d{2}:\d{2} on \d+ \w+\.$/);
  });

  it('an admin sees it in the user details and can remove it, with a reason', async () => {
    const detail = await call('GET', `/admin/users/${user.id}`, { token: ADMIN });
    const addr = detail.body.savedDestinations.cryptoAddresses[0];
    expect(addr).toMatchObject({ assetCode: 'usdt', networkId: 'erc20' });
    const short = await call('DELETE', `/admin/users/${user.id}/crypto-addresses/${addr.id}`, { token: ADMIN, body: { reason: 'short' } });
    expect(short.status).toBe(400);
    const ok = await call('DELETE', `/admin/users/${user.id}/crypto-addresses/${addr.id}`, { token: ADMIN, body: { reason: 'Reported as fraud in an e2e test' } });
    expect(ok.status).toBe(200);
    expect((await call('GET', '/me/crypto-addresses', { token: user.token })).body.items).toEqual([]);
  });
});
