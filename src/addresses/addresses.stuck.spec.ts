import { AlertType, AddressStatus } from '@prisma/client';
import { AddressesService } from './addresses.service';
import { AddressesProcessor } from './addresses.processor';

/**
 * Spec 2026-10-26 part 1: an address Quidax never delivers no longer stays
 * PENDING for ever. It becomes FAILED, a person is alerted, the customer is
 * told, and the customer's next tap tries again (late address first).
 */
type Row = {
  id: string;
  userId: string;
  assetCode: string;
  networkId: string;
  status: AddressStatus;
  address: string | null;
  destinationTag: string | null;
  quidaxAddressId: string | null;
  autoCreated: boolean;
  failedAt: Date | null;
  requestedAt: Date;
};

const NETWORK = { isListed: true, depositsEnabled: true, label: 'Tron Network', requiresTag: false, confirmations: 1 };

function setup(start: Partial<Row> = {}, upstream: Array<{ id: string; address: string | null; network?: string }> = []) {
  let row: Row = {
    id: 'row1',
    userId: 'u1',
    assetCode: 'usdt',
    networkId: 'trc20',
    status: AddressStatus.PENDING,
    address: null,
    destinationTag: null,
    quidaxAddressId: 'qa1',
    autoCreated: false,
    failedAt: null,
    requestedAt: new Date(Date.now() - 3 * 3600_000),
    ...start,
  };
  const withNetwork = () => ({ ...row, network: NETWORK });
  const prisma = {
    assetNetwork: { findUnique: jest.fn(async () => NETWORK) },
    depositAddress: {
      findUnique: jest.fn(async (q: { include?: unknown }) => (q.include ? withNetwork() : row)),
      findMany: jest.fn(async () => [row]),
      update: jest.fn(async ({ data }: { data: Partial<Row> }) => {
        row = { ...row, ...data };
        return withNetwork();
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
        if (where.status && row.status !== where.status) return { count: 0 };
        row = { ...row, ...data };
        return { count: 1 };
      }),
      upsert: jest.fn(async ({ update }: { update: Partial<Row> }) => {
        row = { ...row, ...update };
        return row;
      }),
    },
  };
  let made = 0;
  const quidax = {
    createPaymentAddress: jest.fn(async () => ({ id: `new${++made}`, address: null, destination_tag: null })),
    fetchPaymentAddresses: jest.fn(async () => upstream),
  };
  const notifications = { notify: jest.fn(async () => undefined) };
  const alerts = { raise: jest.fn(async () => true) };
  const queue = { add: jest.fn(async () => undefined) };
  const svc = new AddressesService(
    prisma as never,
    quidax as never,
    { require: jest.fn(async () => undefined) } as never,
    { requireQuidaxId: jest.fn(async () => 'sub-1') } as never,
    { assertDepositsAllowed: jest.fn(async () => undefined) } as never,
    queue as never,
    notifications as never,
    undefined,
    alerts as never,
  );
  return { svc, prisma, quidax, notifications, alerts, queue, current: () => row };
}

describe('Stuck crypto addresses', () => {
  it('the last check without an address marks it FAILED, alerts a person and tells the customer', async () => {
    const t = setup();
    expect(await t.svc.markFailed('row1')).toBe(true);
    expect(t.current().status).toBe(AddressStatus.FAILED);
    expect(t.current().failedAt).toBeInstanceOf(Date);
    expect(t.alerts.raise).toHaveBeenCalledWith(AlertType.CRYPTO_ADDRESS_STUCK, 'address:row1', expect.stringContaining('USDT'), expect.any(Array), expect.any(Number));
    expect(t.notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', type: 'address.failed', body: expect.stringContaining('Open Receive to try again') }),
    );
  });

  it('an address made in advance fails quietly for the customer, but a person is still alerted', async () => {
    const t = setup({ autoCreated: true });
    await t.svc.markFailed('row1');
    expect(t.alerts.raise).toHaveBeenCalled();
    expect(t.notifications.notify).not.toHaveBeenCalled();
  });

  it('an address that arrived meanwhile is never marked failed', async () => {
    const t = setup({ status: AddressStatus.ACTIVE, address: 'TADDR' });
    expect(await t.svc.markFailed('row1')).toBe(false);
    expect(t.current().status).toBe(AddressStatus.ACTIVE);
    expect(t.alerts.raise).not.toHaveBeenCalled();
  });

  it('the poller gives up into FAILED after its 20th check', async () => {
    const t = setup();
    const markFailed = jest.spyOn(t.svc, 'markFailed');
    const processor = new AddressesProcessor(t.svc, t.queue as never);
    const out = await processor.process({ name: 'poll-address', data: { addressId: 'row1', attempt: 20 } } as never);
    expect(out).toEqual({ gaveUp: true });
    expect(markFailed).toHaveBeenCalledWith('row1');
    expect(t.queue.add).not.toHaveBeenCalled();
  });

  it('the hourly sweep checks old PENDING addresses once more, then fails them', async () => {
    const t = setup();
    expect(await t.svc.sweepStuck()).toEqual({ checked: 1, failed: 1 });
    expect(t.quidax.fetchPaymentAddresses).toHaveBeenCalledTimes(1);
    expect(t.current().status).toBe(AddressStatus.FAILED);
  });

  it('the sweep fills in an address that turns up late instead of failing it', async () => {
    const t = setup({}, [{ id: 'qa1', address: 'TLATE', network: 'trc20' }]);
    expect(await t.svc.sweepStuck()).toEqual({ checked: 1, failed: 0 });
    expect(t.current()).toMatchObject({ status: AddressStatus.ACTIVE, address: 'TLATE' });
  });

  it('Try again on a FAILED address: a late address at Quidax is used, no new one is made', async () => {
    const t = setup({ status: AddressStatus.FAILED, failedAt: new Date() }, [{ id: 'qa1', address: 'TLATE', network: 'trc20' }]);
    const view = await t.svc.getOrCreate('u1', 'usdt', 'trc20');
    expect(view).toMatchObject({ status: AddressStatus.ACTIVE, address: 'TLATE', usable: true });
    expect(t.quidax.createPaymentAddress).not.toHaveBeenCalled();
  });

  it('Try again on a FAILED address with nothing at Quidax: exactly one new request, PENDING again', async () => {
    const t = setup({ status: AddressStatus.FAILED, failedAt: new Date() });
    const view = await t.svc.getOrCreate('u1', 'usdt', 'trc20');
    expect(t.quidax.createPaymentAddress).toHaveBeenCalledTimes(1);
    expect(view).toMatchObject({ status: AddressStatus.PENDING, usable: false });
    expect(t.current()).toMatchObject({ failedAt: null, quidaxAddressId: 'new1' });
    expect(t.queue.add).toHaveBeenCalledTimes(1); // the checker starts again
  });
});
