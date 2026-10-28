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
    credit(alice, 'ngn', '100000');
    const q = await call('POST', '/quotes', { token: alice.token, body: { side: 'buy', fromAsset: 'ngn', toAsset: 'usdt', amount: '30000' } });
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
});
