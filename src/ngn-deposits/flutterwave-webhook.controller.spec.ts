import { HttpException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakePrisma } from './testing/fake-prisma';
import { FlutterwaveWebhookController, sameSecret } from './flutterwave-webhook.controller';

const HASH = 'right-hash-value';
const fixture = (name: string) => readFileSync(join(__dirname, '..', 'flutterwave', '__fixtures__', name), 'utf8');

function setup(o: { hash?: string | null } = {}) {
  const db = new FakePrisma();
  const cfg = { secretHash: async () => (o.hash === undefined ? HASH : o.hash) };
  const payIn = { enqueue: jest.fn(async () => undefined) };
  const alerts = { raise: jest.fn(async () => true) };
  const hooks = { dispatch: jest.fn(async () => undefined) };
  const controller = new FlutterwaveWebhookController(db as never, cfg as never, payIn as never, alerts as never, hooks as never);
  const send = (body: string | object, hash?: string) =>
    controller.receive({ rawBody: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) } as never, hash);
  return { db, payIn, alerts, hooks, send };
}

async function status(p: Promise<unknown>): Promise<number> {
  return p.then(
    () => 200,
    (e: unknown) => (e instanceof HttpException ? e.getStatus() : -1),
  );
}

describe('POST /webhooks/flutterwave', () => {
  it('a transfer webhook hands only its reference on (the rail is then asked)', async () => {
    const { hooks, send } = setup();
    await send({ event: 'transfer.completed', data: { id: 77, reference: 'trsy_abc', status: 'SUCCESSFUL' } }, HASH);
    expect(hooks.dispatch).toHaveBeenCalledWith('trsy_abc');
  });

  it('a transfer webhook with a wrong hash reaches nobody', async () => {
    const { hooks, send } = setup();
    await send({ event: 'transfer.completed', data: { id: 77, reference: 'trsy_abc' } }, 'wrong').catch(() => undefined);
    expect(hooks.dispatch).not.toHaveBeenCalled();
  });

  it('stores and queues a legacy-format charge, keeping its fields only as a hint', async () => {
    const { db, payIn, send } = setup();
    await expect(send(fixture('webhook-legacy-charge.json'), HASH)).resolves.toEqual({ received: true });
    expect(db.rows('webhookEvent')).toEqual([expect.objectContaining({ eventName: 'flutterwave.charge', signatureValid: true })]);
    expect(db.rows('flutterwaveCollection')).toEqual([
      expect.objectContaining({
        flwTransactionId: '10535993', outcome: 'UNVERIFIED', firstSource: 'WEBHOOK',
        webhookHint: expect.objectContaining({ txRef: 'dcbt_spike_ead46a4d', amount: '1500' }),
      }),
    ]);
    expect(payIn.enqueue).toHaveBeenCalledWith('10535993', 'WEBHOOK');
  });

  it('stores and queues a v3-format charge', async () => {
    const { db, payIn, send } = setup();
    await send(fixture('webhook-v3-charge.json'), HASH);
    expect(db.rows('flutterwaveCollection')[0].flwTransactionId).toBe('2028146660');
    expect(payIn.enqueue).toHaveBeenCalledWith('2028146660', 'WEBHOOK');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['wrong, same length', 'wrong-hash-value'],
    ['wrong, different length', 'x'],
  ])('answers 401 to a %s verif-hash, records it, alerts, and queues nothing', async (_name, hash) => {
    const { db, payIn, alerts, send } = setup();
    expect(await status(send(fixture('webhook-legacy-charge.json'), hash))).toBe(401);
    expect(db.rows('webhookEvent')).toEqual([
      expect.objectContaining({ eventName: 'flutterwave.unauthenticated', signatureValid: false }),
    ]);
    expect(db.rows('flutterwaveCollection')).toHaveLength(0);
    expect(payIn.enqueue).not.toHaveBeenCalled();
    expect(alerts.raise).toHaveBeenCalledWith(
      'FLUTTERWAVE_WEBHOOK_REJECTED', 'webhook-rejected', expect.any(String), expect.any(Array), expect.any(Number),
    );
  });

  it('answers 401 to everything while no hash is configured', async () => {
    const { payIn, send } = setup({ hash: null });
    expect(await status(send(fixture('webhook-legacy-charge.json'), HASH))).toBe(401);
    expect(payIn.enqueue).not.toHaveBeenCalled();
  });

  it('stores only metadata, never the body, for an unauthenticated webhook', async () => {
    const { db, send } = setup();
    const sensitiveBody = { event: 'charge.completed', data: { id: '123', customer: { email: 'leak@example.com' } } };
    const bodyJson = JSON.stringify(sensitiveBody);
    const bodyBytes = Buffer.byteLength(bodyJson, 'utf8');
    expect(await status(send(bodyJson, 'wrong-hash'))).toBe(401);
    const stored = db.rows('webhookEvent')[0];
    expect(stored).toBeDefined();
    expect(stored.eventName).toBe('flutterwave.unauthenticated');
    expect(stored.payload).toEqual({ bytes: bodyBytes, reason: 'wrong', json: true });
    expect(JSON.stringify(stored.payload)).not.toContain('leak@example.com');
  });

  it('stores a repeated delivery once and still answers 200', async () => {
    const { db, payIn, send } = setup();
    await send(fixture('webhook-legacy-charge.json'), HASH);
    await expect(send(fixture('webhook-legacy-charge.json'), HASH)).resolves.toEqual({ received: true });
    expect(db.rows('webhookEvent')).toHaveLength(1);
    expect(db.rows('flutterwaveCollection')).toHaveLength(1);
    expect(payIn.enqueue).toHaveBeenCalledTimes(2); // the job id collapses these in BullMQ
  });

  it('stores a transfer event for payouts, and queues nothing', async () => {
    const { db, payIn, send } = setup();
    await send({ event: 'transfer.completed', data: { id: 77, status: 'SUCCESSFUL' } }, HASH);
    expect(db.rows('webhookEvent')[0].eventName).toBe('flutterwave.transfer');
    expect(db.rows('flutterwaveCollection')).toHaveLength(0);
    expect(payIn.enqueue).not.toHaveBeenCalled();
  });

  it('stores an event without a usable id as OTHER, and looks nothing up', async () => {
    const { db, payIn, send } = setup();
    await send({ event: 'charge.completed', data: { id: '1/../2' } }, HASH);
    expect(db.rows('webhookEvent')[0].eventName).toBe('flutterwave.other');
    expect(payIn.enqueue).not.toHaveBeenCalled();
  });

  it('answers 500 when it cannot store, so Flutterwave retries', async () => {
    const { db, payIn, send } = setup();
    db.failNext('flutterwaveCollection', 'upsert', new Error('database unavailable'));
    expect(await status(send(fixture('webhook-legacy-charge.json'), HASH))).toBe(500);
    expect(payIn.enqueue).not.toHaveBeenCalled();
  });

  it('still answers 200 when only the queue fails: the payment is stored and the re-check finds it', async () => {
    const { db, payIn, send } = setup();
    payIn.enqueue.mockRejectedValueOnce(new Error('redis down'));
    await expect(send(fixture('webhook-legacy-charge.json'), HASH)).resolves.toEqual({ received: true });
    expect(db.rows('flutterwaveCollection')).toHaveLength(1);
  });

  it('answers 413 above 64 KB, before anything else', async () => {
    const { db, send } = setup();
    const big = JSON.stringify({ event: 'charge.completed', data: { id: 1 }, pad: 'x'.repeat(70_000) });
    expect(await status(send(big, HASH))).toBe(413);
    expect(db.rows('webhookEvent')).toHaveLength(0);
  });

  it('answers 400 to a body that is not JSON', async () => {
    const { send } = setup();
    expect(await status(send('not json', HASH))).toBe(400);
  });
});

describe('sameSecret', () => {
  it('compares in constant time, whatever the lengths', () => {
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abd', 'abc')).toBe(false);
    expect(sameSecret('a', 'abc')).toBe(false);
    expect(sameSecret(undefined, 'abc')).toBe(false);
    expect(sameSecret('', 'abc')).toBe(false);
  });
});
