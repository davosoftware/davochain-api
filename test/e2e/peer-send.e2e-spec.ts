import { adminToken, balance, call, credit, hasAdmin, key, newUser, requireServer, verifyBasic, type TestUser } from './helpers';

/**
 * Coins sent to another DavoChain customer's address (28 Oct 2026). Before the
 * fix the sender was charged and the receiver never credited: Quidax moves
 * such a send "internally" and our deposits ignore internal arrivals.
 * Needs E2E_ADMIN_* to switch the new-address wait off for the run.
 */
const describeAdmin = hasAdmin ? describe : describe.skip;

describeAdmin('sending coins to another DavoChain customer by address', () => {
  let ADMIN: string;
  let original: { rules: unknown[]; cooloffs: Array<Record<string, unknown>>; platform: unknown };
  let alice: TestUser;
  let bob: TestUser;
  let bobAddress: string;

  beforeAll(async () => {
    await requireServer();
    ADMIN = (await adminToken())!;
    original = (await call('GET', '/admin/levels', { token: ADMIN })).body;
    const cooloffs = original.cooloffs.map((c) => ({ ...c, afterNewPayeeHours: 0, afterSignupHours: 0, afterCredentialChangeHours: 0 }));
    expect((await call('PUT', '/admin/levels', { token: ADMIN, body: { rules: original.rules, cooloffs, platform: original.platform } })).status).toBe(200);

    alice = await verifyBasic(await newUser('Alice', 'Sender'));
    bob = await verifyBasic(await newUser('Bob', 'Receiver'));

    // Alice buys USDT, so her Quidax account really holds it.
    credit(alice, 'ngn', '400000');
    const q = await call('POST', '/quotes', { token: alice.token, body: { side: 'buy', fromAsset: 'ngn', toAsset: 'usdt', amount: '200000' } });
    const t = await call('POST', '/trades', { token: alice.token, body: { quoteId: q.body.quoteId }, headers: { 'Idempotency-Key': key() } });
    expect(t.body.status).toBe('COMPLETED');

    // Bob's USDT deposit address.
    await call('POST', '/deposits/address', { token: bob.token, body: { asset: 'usdt', network: 'erc20' } });
    for (let i = 0; i < 40 && !bobAddress; i++) {
      const list = (await call('GET', '/deposits/addresses', { token: bob.token })).body as Array<{ asset: string; address: string | null }>;
      bobAddress = list.find((a) => a.asset === 'usdt' && a.address)?.address ?? '';
      if (!bobAddress) await new Promise((r) => setTimeout(r, 500));
    }
    expect(bobAddress).toBeTruthy();
  }, 60_000);

  afterAll(async () => {
    if (original) await call('PUT', '/admin/levels', { token: ADMIN, body: { rules: original.rules, cooloffs: original.cooloffs, platform: original.platform } });
  });

  async function send(from: TestUser, address: string, amount: string) {
    const saved = await call('POST', '/me/crypto-addresses', { token: from.token, body: { asset: 'usdt', network: 'erc20', address, password: from.password } });
    if (saved.status !== 201) return saved;
    return call('POST', '/withdrawals/crypto', { token: from.token, body: { amount, savedCryptoAddressId: saved.body.id }, headers: { 'Idempotency-Key': key() } });
  }

  it("Bob receives what Alice sends to his address, at once and with no fee", async () => {
    const aliceBefore = Number((await balance(alice, 'usdt')).available);
    const bobBefore = Number((await balance(bob, 'usdt').catch(() => ({ available: '0' }))).available);

    const w = await send(alice, bobAddress, '5');
    expect(w.status).toBe(201);
    expect(w.body).toMatchObject({ status: 'COMPLETED', toDavoChainCustomer: true });

    expect(Number((await balance(alice, 'usdt')).available)).toBeCloseTo(aliceBefore - 5, 6);
    expect(Number((await balance(bob, 'usdt')).available)).toBeCloseTo(bobBefore + 5, 6);

    const deposits = (await call('GET', '/deposits', { token: bob.token })).body as Array<Record<string, unknown>>;
    expect(deposits.length).toBeGreaterThan(0);
  });

  it('sending to your own DavoChain address is refused', async () => {
    const own = await send(bob, bobAddress, '1');
    expect(own.status).toBe(400);
  });

  it('the fee quote for a DavoChain address shows no fees', async () => {
    const saved = await call('POST', '/me/crypto-addresses', { token: alice.token, body: { asset: 'usdt', network: 'erc20', address: bobAddress, password: alice.password } });
    const id = saved.status === 201 ? saved.body.id : (await call('GET', '/me/crypto-addresses', { token: alice.token })).body.items[0].id;
    const q = await call('GET', `/withdrawals/quote?asset=usdt&amount=5&network=erc20&savedCryptoAddressId=${id}`, { token: alice.token });
    expect(q.status).toBe(200);
    expect(q.body).toMatchObject({ toDavoChainCustomer: true, totalFee: '0.000000', youReceive: '5.000000' });
  });

  describe('by payment username', () => {
    const name = `bob_${Date.now().toString(36)}`;

    it('Bob chooses a username; rules and clashes are explained', async () => {
      expect((await call('PUT', '/me/pay-username', { token: bob.token, body: { username: 'bob' } })).body).toMatchObject({ code: 'USERNAME_INVALID', message: expect.stringMatching(/at least 7/) });
      const set = await call('PUT', '/me/pay-username', { token: bob.token, body: { username: name.toUpperCase() } });
      expect(set.status).toBe(200);
      expect(set.body).toEqual({ payUsername: name });
      expect((await call('GET', '/me', { token: bob.token })).body.payUsername).toBe(name);
      const clash = await call('PUT', '/me/pay-username', { token: alice.token, body: { username: name } });
      expect(clash.status).toBe(409);
      expect((await call('GET', `/me/pay-username/check?username=${name}`, { token: alice.token })).body).toMatchObject({ available: false });
    });

    it('Alice looks Bob up and sees a short name', async () => {
      const r = await call('GET', `/transfers/recipient?username=@${name}`, { token: alice.token });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ username: name, displayName: 'Bob R.', canReceive: true, reason: null });
      expect((await call('GET', '/transfers/recipient?username=nobody_at_all_x', { token: alice.token })).status).toBe(404);
    });

    it('Alice sends 3 USDT by username: free, instant, both histories say who', async () => {
      const aliceBefore = Number((await balance(alice, 'usdt')).available);
      const bobBefore = Number((await balance(bob, 'usdt')).available);
      const r = await call('POST', '/transfers/crypto', { token: alice.token, body: { username: name, asset: 'usdt', amount: '3' }, headers: { 'Idempotency-Key': key() } });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ status: 'COMPLETED', toDavoChainCustomer: true, to: { username: name } });
      expect(Number((await balance(alice, 'usdt')).available)).toBeCloseTo(aliceBefore - 3, 6);
      expect(Number((await balance(bob, 'usdt')).available)).toBeCloseTo(bobBefore + 3, 6);
      const out = (await call('GET', '/withdrawals', { token: alice.token })).body[0];
      expect(out.to).toEqual({ username: name, displayName: 'Bob R.' });
      const inn = (await call('GET', '/deposits', { token: bob.token })).body[0];
      expect(inn.from).toMatchObject({ displayName: 'Alice S.' });
    });

    it('a large first send needs no password now: the PIN replaced it (29 Oct 2026)', async () => {
      const carol = await verifyBasic(await newUser('Carol', 'Third'));
      const carolName = `carol_${Date.now().toString(36)}`;
      await call('PUT', '/me/pay-username', { token: carol.token, body: { username: carolName } });
      const r = await call('POST', '/transfers/crypto', { token: alice.token, body: { username: carolName, asset: 'usdt', amount: '80' }, headers: { 'Idempotency-Key': key() } });
      expect(r.status).toBe(201);
      expect(Number((await balance(carol, 'usdt')).available)).toBeCloseTo(80, 6);
    });
  });

  describe('every customer has a username from sign-up', () => {
    it('a new customer gets "firstname_digits" at once, and can change it straight away, then not again for 30 days', async () => {
      const dan = await newUser('Dan', 'Fresh');
      const me = (await call('GET', '/me', { token: dan.token })).body;
      expect(me.payUsername).toMatch(/^dan_\d{4,8}$/);
      expect((await call('GET', '/me/pay-username', { token: dan.token })).body).toEqual({ payUsername: me.payUsername, chosenByYou: false, canChangeFrom: null });

      const name = `dan_${Date.now().toString(36)}`;
      expect((await call('PUT', '/me/pay-username', { token: dan.token, body: { username: name } })).status).toBe(200);
      const after = (await call('GET', '/me/pay-username', { token: dan.token })).body;
      expect(after).toMatchObject({ payUsername: name, chosenByYou: true, canChangeFrom: expect.any(String) });

      const again = await call('PUT', '/me/pay-username', { token: dan.token, body: { username: `${name}x` } });
      expect(again.status).toBe(400);
      expect(again.body.code).toBe('USERNAME_CHANGE_TOO_SOON');
    });
  });
});
