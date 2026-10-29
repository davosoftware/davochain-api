import { QuidaxMockClient } from './quidax.mock';
import { QuidaxClient } from './quidax.client';
import { QuidaxMockRestore } from './quidax-mock-restore';

function mock() {
  const config = {
    getOrThrow: () => 'https://openapi.quidax.io/exchange-open-api/api/v1',
    get: () => undefined,
  };
  return new QuidaxMockClient(config as never, {} as never);
}

/** Balance rows as the restore asks for them: only coins, only customers with a Quidax account. */
function prisma(rows: { assetCode: string; available: string; locked: string; quidaxUserId: string }[]) {
  const findMany = jest.fn(async () =>
    rows.map((r) => ({
      assetCode: r.assetCode,
      available: r.available,
      locked: r.locked,
      user: { quidaxAccount: { quidaxUserId: r.quidaxUserId } },
    })),
  );
  return { balance: { findMany } };
}

const balanceOf = async (quidax: QuidaxMockClient, currency: string, user: string) =>
  Number((await quidax.fetchWallet(currency, user)).balance);

describe('QuidaxMockRestore', () => {
  it('after a restart, each customer holds at the stand-in what our records say they own, locked coins included', async () => {
    const quidax = mock();
    const db = prisma([
      { assetCode: 'usdt', available: '120.5', locked: '50', quidaxUserId: 'qx-ada' },
      { assetCode: 'btc', available: '0.0004', locked: '0', quidaxUserId: 'qx-ada' },
      { assetCode: 'eth', available: '0', locked: '0', quidaxUserId: 'qx-bola' },
    ]);

    const restored = await new QuidaxMockRestore(quidax, db as never).restore();

    expect(restored).toBe(2);
    await expect(balanceOf(quidax, 'usdt', 'qx-ada')).resolves.toBe(170.5);
    await expect(balanceOf(quidax, 'btc', 'qx-ada')).resolves.toBe(0.0004);
    await expect(balanceOf(quidax, 'eth', 'qx-bola')).resolves.toBe(0);
    // Only coins, and only customers with a Quidax account, are asked for.
    expect(db.balance.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { asset: { isFiat: false }, user: { quidaxAccount: { isNot: null } } },
      }),
    );
  });

  it('a send that failed for lack of coins at the stand-in works once they are restored', async () => {
    const quidax = mock();
    const db = prisma([{ assetCode: 'usdt', available: '80', locked: '0', quidaxUserId: 'qx-ada' }]);
    await expect(
      quidax.internalTransfer('qx-ada', { currency: 'usdt', amount: '50', fund_uid: 'qx-bola', reference: 'dvc_peer_r1' }),
    ).rejects.toThrow('Insufficient balance');

    await new QuidaxMockRestore(quidax, db as never).restore();

    await quidax.internalTransfer('qx-ada', { currency: 'usdt', amount: '50', fund_uid: 'qx-bola', reference: 'dvc_peer_r2' });
    await expect(balanceOf(quidax, 'usdt', 'qx-bola')).resolves.toBe(50);
  });

  it('never touches the real Quidax', async () => {
    const real = Object.create(QuidaxClient.prototype) as QuidaxClient;
    const db = prisma([{ assetCode: 'usdt', available: '80', locked: '0', quidaxUserId: 'qx-ada' }]);

    await expect(new QuidaxMockRestore(real, db as never).restore()).resolves.toBe(0);
    expect(db.balance.findMany).not.toHaveBeenCalled();
  });
});
