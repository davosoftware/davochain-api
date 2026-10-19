import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonExact } from '../common/exact-json';
import { parseFlutterwaveWebhook } from './webhook-payload';

const fixture = (name: string) =>
  parseJsonExact(readFileSync(join(__dirname, '..', 'flutterwave', '__fixtures__', name), 'utf8'));

describe('parseFlutterwaveWebhook', () => {
  it('reads the flat legacy body the sandbox actually sends', () => {
    expect(parseFlutterwaveWebhook(fixture('webhook-legacy-charge.json'))).toEqual({
      kind: 'CHARGE',
      eventName: 'flutterwave.charge',
      transactionId: '10535993',
      transferReference: null,
      hint: {
        event: 'BANK_TRANSFER_TRANSACTION', id: '10535993', txRef: 'dcbt_spike_ead46a4d',
        flwRef: '1155648034391791382464103', amount: '1500', currency: 'NGN', status: 'successful',
      },
    });
  });

  it('reads the documented v3 envelope', () => {
    expect(parseFlutterwaveWebhook(fixture('webhook-v3-charge.json'))).toMatchObject({
      kind: 'CHARGE',
      transactionId: '2028146660',
      hint: { event: 'charge.completed', txRef: 'dcva_7f3c2a1b9e8d4c6fa1b2c3d4e5f60718', amount: '100' },
    });
  });

  it('recognises transfer events, which are left for payouts', () => {
    expect(parseFlutterwaveWebhook({ event: 'transfer.completed', data: { id: '99' } })).toMatchObject({
      kind: 'TRANSFER', eventName: 'flutterwave.transfer', transactionId: '99',
    });
    expect(parseFlutterwaveWebhook({ 'event.type': 'Transfer', id: '98' }).kind).toBe('TRANSFER');
  });

  it.each([
    ['a path-shaped id', '1/../2'],
    ['a 20-digit id', '12345678901234567890'],
    ['letters', 'abc'],
    ['a decimal', '1.5'],
    ['a negative number', '-7'],
  ])('refuses %s, so nothing is looked up', (_name, id) => {
    expect(parseFlutterwaveWebhook({ event: 'charge.completed', data: { id } })).toMatchObject({
      kind: 'OTHER', eventName: 'flutterwave.other', transactionId: null,
    });
  });

  it('treats anything else, including junk, as OTHER', () => {
    expect(parseFlutterwaveWebhook({ event: 'subscription.cancelled', data: { id: '5' } }).kind).toBe('OTHER');
    expect(parseFlutterwaveWebhook(null).kind).toBe('OTHER');
    expect(parseFlutterwaveWebhook(['x']).kind).toBe('OTHER');
  });
});
