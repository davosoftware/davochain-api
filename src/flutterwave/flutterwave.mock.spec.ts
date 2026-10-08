import http from 'node:http';
import { AddressInfo } from 'node:net';
import { dec } from '../common/money';
import { FlutterwaveError } from './flutterwave.errors';
import { FlutterwaveMockClient, mockFee } from './flutterwave.mock';

function mock(port = 1) {
  const cfg = {
    baseUrl: 'http://unused',
    rateLimitPerMinute: 100_000,
    port,
    secretKey: async () => 'FLWSECK_TEST-x-X',
    secretHash: async () => 'mock-hash',
  };
  return new FlutterwaveMockClient(cfg as never);
}

const account = { email: 'a@x.y', firstName: 'A', lastName: 'B', narration: 'A B' };

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, port: (server.address() as AddressInfo).port };
}

async function close(server: http.Server) {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}

describe('FlutterwaveMockClient', () => {
  it('opens permanent accounts with distinct numbers and order refs', async () => {
    const m = mock();
    const a = await m.createStaticVirtualAccount({ ...account, txRef: 'dcva_a', bvn: '22222223883' });
    const b = await m.createStaticVirtualAccount({ ...account, txRef: 'dcva_b', nin: '12345678901' });
    expect(a.account_number).not.toBe(b.account_number);
    expect(a.order_ref).not.toBe(b.order_ref);
    expect(a.account_status).toBe('active');
  });

  it('refuses a static account without exactly one identity number, like Flutterwave', async () => {
    await expect(mock().createStaticVirtualAccount({ ...account, txRef: 't' })).rejects.toMatchObject({ kind: 'DEFINITE' });
  });

  it('deactivates and reactivates', async () => {
    const m = mock();
    const a = await m.createStaticVirtualAccount({ ...account, txRef: 't', bvn: '22222223883' });
    await m.setVirtualAccountStatus(a.order_ref, 'inactive');
    expect((await m.getVirtualAccount(a.order_ref)).account_status).toBe('inactive');
    await m.setVirtualAccountStatus(a.order_ref, 'active');
    expect((await m.getVirtualAccount(a.order_ref)).account_status).toBe('active');
  });

  it('charges the sandbox fee: 1.4%, 2 dp, capped at ₦2,000', () => {
    expect(mockFee(dec('1500')).toFixed()).toBe('21');
    expect(mockFee(dec('1500.50')).toFixed()).toBe('21.01');
    expect(mockFee(dec('1000000')).toFixed()).toBe('2000');
  });

  it('simulates a pay-in that verify then reports exactly', async () => {
    const m = mock();
    const a = await m.createStaticVirtualAccount({ ...account, txRef: 'dcva_a', bvn: '22222223883' });
    const { id } = await m.simulatePayIn({ txRef: 'dcva_a', amount: '1500', payerName: 'ADA OBI', sendWebhook: false });
    const tx = await m.verifyTransaction(id);
    expect(tx).toMatchObject({
      id,
      tx_ref: 'dcva_a',
      amount: '1500',
      charged_amount: '1500',
      app_fee: '21',
      merchant_fee: '0',
      amount_settled: '1479',
      currency: 'NGN',
      status: 'successful',
      payment_type: 'bank_transfer',
    });
    expect(tx.meta).toMatchObject({ virtualaccountnumber: a.account_number, originatorname: 'ADA OBI' });
  });

  it('answers NOT_FOUND for an id it never issued', async () => {
    const err = (await mock().verifyTransaction('123').catch((e: unknown) => e)) as FlutterwaveError;
    expect(err.kind).toBe('NOT_FOUND');
  });

  it('returns exactly what was seeded, for tests that need an odd answer', async () => {
    const m = mock();
    m.seedTransaction({ id: '77', tx_ref: 'dcva_a', amount: '100', app_fee: '9', amount_settled: '90', currency: 'NGN', status: 'successful', payment_type: 'bank_transfer' });
    await expect(m.verifyTransaction('77')).resolves.toMatchObject({ app_fee: '9', amount_settled: '90' });
  });

  it('lists successful NGN payments ten to a page', async () => {
    const m = mock();
    for (let i = 0; i < 12; i++) await m.simulatePayIn({ txRef: 'dcva_a', amount: '100', sendWebhook: false });
    const q = { from: '2026-01-01', to: '2030-01-01', status: 'successful', currency: 'NGN' };
    const p1 = await m.listTransactions({ ...q, page: 1 });
    const p2 = await m.listTransactions({ ...q, page: 2 });
    expect(p1.totalPages).toBe(2);
    expect(p1.items).toHaveLength(10);
    expect(p2.items).toHaveLength(2);
  });

  it('fails the next call on demand, once', async () => {
    const m = mock();
    m.failNext('getBalance', new Error('boom'));
    await expect(m.getBalance('NGN')).rejects.toThrow('boom');
    await expect(m.getBalance('NGN')).resolves.toMatchObject({ currency: 'NGN' });
  });

  it('delivers the webhook to our own endpoint with the hash, in either format, and redelivers on demand', async () => {
    const received: Array<{ url?: string; hash?: string; body: Record<string, unknown> }> = [];
    const { server, port } = await listen((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ url: req.url, hash: req.headers['verif-hash'] as string, body: JSON.parse(body) });
        res.writeHead(200);
        res.end('{}');
      });
    });
    try {
      const m = mock(port);
      const legacy = await m.simulatePayIn({ txRef: 'dcva_a', amount: '1500' });
      const v3 = await m.simulatePayIn({ txRef: 'dcva_a', amount: '200', format: 'v3' });
      expect(legacy.webhookStatus).toBe(200);
      expect(received[0]).toMatchObject({ url: '/webhooks/flutterwave', hash: 'mock-hash' });
      expect(received[0].body).toMatchObject({ id: Number(legacy.id), txRef: 'dcva_a', 'event.type': 'BANK_TRANSFER_TRANSACTION' });
      expect(received[1].body).toMatchObject({ event: 'charge.completed', data: { id: Number(v3.id), tx_ref: 'dcva_a' } });
      await expect(m.redeliverWebhook(legacy.id)).resolves.toBe(200);
      expect(received[2].body).toMatchObject({ id: Number(legacy.id) });
    } finally {
      await close(server);
    }
  });

  it('reports a failed delivery instead of throwing', async () => {
    const { server, port } = await listen((_req, res) => res.end());
    await close(server); // nothing listens on this port now
    const result = await mock(port).simulatePayIn({ txRef: 'dcva_a', amount: '100' });
    expect(result.webhookStatus).toBeNull();
  });
});
