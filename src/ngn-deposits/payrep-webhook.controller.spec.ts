import { PayloadTooLargeException, UnauthorizedException } from '@nestjs/common';
import { payrepSignature } from '../payrep/webhook-signature';
import { PayrepWebhookController } from './payrep-webhook.controller';

const SECRET = 'c'.repeat(64);

describe('POST /webhooks/payrep (spec §6.1)', () => {
  let prisma: { webhookEvent: { create: jest.Mock; count: jest.Mock } };
  let alerts: { raise: jest.Mock };
  let hooks: { dispatch: jest.Mock };
  let intake: { intake: jest.Mock };
  let ctrl: PayrepWebhookController;

  const send = (body: object, opts: { ts?: number; sig?: string } = {}) => {
    const raw = Buffer.from(JSON.stringify(body));
    const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
    return ctrl.receive({ rawBody: raw } as never, ts, opts.sig ?? payrepSignature(SECRET, ts, raw), 'wh-1');
  };

  beforeEach(() => {
    prisma = { webhookEvent: { create: jest.fn().mockResolvedValue({}), count: jest.fn().mockResolvedValue(1) } };
    alerts = { raise: jest.fn().mockResolvedValue(true) };
    hooks = { dispatch: jest.fn().mockResolvedValue(undefined) };
    intake = { intake: jest.fn().mockResolvedValue(undefined) };
    ctrl = new PayrepWebhookController(prisma as never, { webhookSecret: async () => SECRET, nodeEnv: 'test' } as never, alerts as never, hooks as never, intake as never);
  });

  it('a signed transfer.success is stored (processed) and handed to the owner of the reference', async () => {
    await expect(send({ event: 'transfer.success', data: { transaction_id: 't1', reference_number: 'dvc_ngnwd_1' } })).resolves.toEqual({ received: true });
    expect(prisma.webhookEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventName: 'payrep.transfer.success', signatureValid: true, processedAt: expect.any(Date) }),
    });
    expect(hooks.dispatch).toHaveBeenCalledWith('dvc_ngnwd_1');
  });

  it('transfer.failed and transfer.pending also ask the owner to check', async () => {
    await send({ event: 'transfer.failed', data: { transaction_id: 't2', reference_number: 'trsy_9' } });
    await send({ event: 'transfer.pending', data: { transaction_id: 't3', reference_number: 'trsy_10' } });
    expect(hooks.dispatch.mock.calls).toEqual([['trsy_9'], ['trsy_10']]);
  });

  it('a wrong signature is 401, recorded without the body, and nothing is dispatched', async () => {
    await expect(send({ event: 'transfer.success', data: { reference_number: 'x' } }, { sig: 'f'.repeat(64) })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(hooks.dispatch).not.toHaveBeenCalled();
    const stored = prisma.webhookEvent.create.mock.calls[0][0].data;
    expect(stored).toMatchObject({ eventName: 'payrep.unauthenticated', signatureValid: false });
    expect(JSON.stringify(stored.payload)).not.toContain('transfer.success'); // only base64 of the body, kept outside production
  });

  it('outside production a refused delivery keeps what check-payrep needs; in production it keeps nothing', async () => {
    await expect(send({ event: 'x' }, { sig: 'bad' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.webhookEvent.create.mock.calls[0][0].data.payload.capture).toMatchObject({ signature: 'bad', body: expect.any(String) });
    ctrl = new PayrepWebhookController(prisma as never, { webhookSecret: async () => SECRET, nodeEnv: 'production' } as never, alerts as never, hooks as never, intake as never);
    await expect(send({ event: 'x' }, { sig: 'bad' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.webhookEvent.create.mock.calls[1][0].data.payload.capture).toBeNull();
  });

  it('a stale but valid signature is 401 (Review Focus 3)', async () => {
    await expect(send({ event: 'deposit.success', data: { transaction_id: 't' } }, { ts: Math.floor(Date.now() / 1000) - 3600 })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(intake.intake).not.toHaveBeenCalled();
  });

  it('no secret configured: every webhook is refused', async () => {
    ctrl = new PayrepWebhookController(prisma as never, { webhookSecret: async () => null, nodeEnv: 'test' } as never, alerts as never, hooks as never, intake as never);
    await expect(send({ event: 'deposit.success', data: { transaction_id: 't' } })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('owners are alerted once 3 refusals land within an hour', async () => {
    await expect(send({ event: 'x' }, { sig: 'bad' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(alerts.raise).not.toHaveBeenCalled();
    prisma.webhookEvent.count.mockResolvedValue(3);
    await expect(send({ event: 'x' }, { sig: 'bad' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(alerts.raise).toHaveBeenCalledWith('NAIRA_WEBHOOK_REJECTED', 'webhook-rejected', expect.any(String), expect.any(Array), expect.any(Number));
  });

  it('deposit.success goes to intake keyed on its reference (the id the transaction list also has), de-duplicated', async () => {
    await send({ event: 'deposit.success', data: { transaction_id: 't9', account_number: '2012345678', reference_number: 'R9', created_at: '2026-10-21T10:00:00Z' } });
    expect(intake.intake).toHaveBeenCalledWith(
      { transactionId: 'R9', accountNumber: '2012345678', referenceNumber: 'R9', createdAt: '2026-10-21T10:00:00Z', event: 'deposit.success' },
      'WEBHOOK',
    );
    const dedup = prisma.webhookEvent.create.mock.calls[0][0].data.dedupHash;
    prisma.webhookEvent.create.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }));
    // A retry with a new X-Webhook-Id and timestamp: same event, same dedup key, still 200.
    await expect(send({ event: 'deposit.success', data: { transaction_id: 't9', account_number: '2012345678' } })).resolves.toEqual({ received: true });
    expect(prisma.webhookEvent.create.mock.calls[1][0].data.dedupHash).toBe(dedup);
  });

  it('a storage failure is 500 so Payrep retries', async () => {
    prisma.webhookEvent.create.mockRejectedValueOnce(new Error('db down'));
    await expect(send({ event: 'deposit.success', data: { transaction_id: 't1' } })).rejects.toThrow(/retry/);
    expect(intake.intake).not.toHaveBeenCalled();
  });

  // The sandbox (22 Oct 2026) calls a deposit "collection.success"; its payload has no transaction_id
  // and reference_number is null. The bank's third_party_reference_number is the id, as in the list.
  const COLLECTION = {
    amount: '5000.00', status: 'successful', channel: 'webhook', charges: '0.00', account_number: '2012345678', reference_number: null,
    sender_account_name: 'ADA OBI', sender_account_number: '0123456789', sender_bank_name: 'Access Bank', transaction_type: 'credit',
    third_party_reference_number: '000013251022120000', created_at: '2026-10-22T10:00:00.000000+01:00',
  };
  it.each([
    ['wrapped as {event, data}', { event: 'collection.success', data: COLLECTION }],
    ['flat, with the event beside the fields', { event: 'collection.success', ...COLLECTION }],
    ['flat, with event_type', { event_type: 'collection.success', ...COLLECTION }],
  ])('a sandbox-shaped collection.success, %s, reaches the deposit side keyed on the bank reference', async (_n, body) => {
    await expect(send(body)).resolves.toEqual({ received: true });
    expect(intake.intake).toHaveBeenCalledWith(
      { transactionId: '000013251022120000', accountNumber: '2012345678', referenceNumber: null, createdAt: '2026-10-22T10:00:00.000000+01:00', event: 'collection.success' },
      'WEBHOOK',
    );
    expect(prisma.webhookEvent.create.mock.calls[0][0].data.eventName).toBe('payrep.collection.success');
  });

  it('transfer.reversal and deposit.reversed alert an owner; nothing moves', async () => {
    await send({ event: 'transfer.reversal', data: { transaction_id: 'r1', reference_number: 'dvc_ngnwd_2', amount: '500.00' } });
    expect(alerts.raise).toHaveBeenCalledWith('PAYOUT_REVERSED', 'reversal:dvc_ngnwd_2', expect.any(String), expect.any(Array), expect.any(Number));
    await send({ event: 'deposit.reversed', data: { transaction_id: 'd1', amount: '700.00', account_number: '2012345678' } });
    expect(alerts.raise).toHaveBeenCalledWith('DEPOSIT_REVERSED', 'reversed:d1', expect.any(String), expect.any(Array), expect.any(Number));
    expect(hooks.dispatch).not.toHaveBeenCalled();
    expect(intake.intake).not.toHaveBeenCalled();
  });

  it('deposit.failed and other events are recorded only', async () => {
    await send({ event: 'deposit.failed', data: { third_party_reference_number: 'TP1', reason: 'invalid_amount' } });
    await send({ event: 'account.created', data: { account_number: '2012345678' } });
    expect(intake.intake).not.toHaveBeenCalled();
    expect(hooks.dispatch).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(2);
  });

  it('never stores a BVN or NIN that an event might carry (final review I4)', async () => {
    await send({
      event: 'account.created',
      data: { account_number: '2012345678', bvn: '22222222222', customer: { nin: '70123456789', identity_number: '1', id_number: '2' }, note: 'phone 08012345678' },
    });
    const stored = JSON.stringify(prisma.webhookEvent.create.mock.calls[0][0].data.payload);
    expect(stored).not.toMatch(/22222222222|70123456789|08012345678|"bvn"|"nin"|identity_number|id_number/);
    expect(stored).toContain('2012345678');
  });

  it('bodies over 64 KB are refused before anything else', async () => {
    await expect(ctrl.receive({ rawBody: Buffer.alloc(65 * 1024) } as never, '1', 'x', 'w')).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
  });
});
