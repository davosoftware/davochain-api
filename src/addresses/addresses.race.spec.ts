import { AddressesService } from './addresses.service';

/**
 * OPEN_ISSUES A6: two requests for the same NEW coin and network at the same
 * instant made Quidax create two addresses (one never shown). Now one request
 * per customer, coin and network creates; the other gets the same address.
 */
function setup() {
  let row: Record<string, unknown> | null = null;
  const prisma = {
    assetNetwork: { findUnique: jest.fn(async () => ({ isListed: true, depositsEnabled: true, label: 'TRC20', requiresTag: false, confirmations: 1 })) },
    depositAddress: {
      findUnique: jest.fn(async () => row),
      upsert: jest.fn(async ({ create }: { create: Record<string, unknown> }) => (row = { id: 'row1', ...create })),
    },
  };
  let made = 0;
  const quidax = {
    createPaymentAddress: jest.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      made++;
      return { id: `qa${made}`, address: 'TADDR', destination_tag: null };
    }),
  };
  const held = new Set<string>();
  const leases = {
    run: jest.fn(async (name: string, _ttl: number, fn: () => Promise<unknown>) => {
      if (held.has(name)) return { ran: false };
      held.add(name);
      try {
        return { ran: true, result: await fn() };
      } finally {
        held.delete(name);
      }
    }),
  };
  const svc = new AddressesService(
    prisma as never,
    quidax as never,
    { require: jest.fn(async () => undefined) } as never,
    { requireQuidaxId: jest.fn(async () => 'sub-1') } as never,
    { assertDepositsAllowed: jest.fn(async () => undefined) } as never,
    { add: jest.fn() } as never,
    {} as never,
    leases as never,
  );
  (svc as unknown as { waitMs: number }).waitMs = 5;
  return { svc, quidax };
}

describe('Deposit addresses: one per customer, coin and network, even when asked twice at once', () => {
  it('two requests at the same instant: Quidax is asked once, both get the same address', async () => {
    const { svc, quidax } = setup();
    const [a, b] = await Promise.all([svc.getOrCreate('u1', 'usdt', 'trc20'), svc.getOrCreate('u1', 'usdt', 'trc20')]);
    expect(quidax.createPaymentAddress).toHaveBeenCalledTimes(1);
    expect(a.address).toBe('TADDR');
    expect(b.address).toBe('TADDR');
  });
});
