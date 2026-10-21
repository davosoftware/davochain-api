import { listOf, parseCollection } from './payrep.parse';

describe('listOf: fetch_transactions has no documented response shape (Review Focus 2)', () => {
  it.each([[[{ a: 1 }]], [{ results: [{ a: 1 }] }], [{ transactions: [{ a: 1 }] }], [{ data: [{ a: 1 }] }], [{ items: [{ a: 1 }] }]])(
    'finds the list in %j',
    (data) => expect(listOf(data)).toEqual([{ a: 1 }]),
  );
  it('anything else is an empty list', () => {
    expect(listOf({ nothing: true })).toEqual([]);
    expect(listOf(null)).toEqual([]);
    expect(listOf('x')).toEqual([]);
  });
});

describe('parseCollection', () => {
  const raw = {
    transaction_id: '550e8400-e29b-41d4-a716-446655440000',
    reference_number: 'TXN-1',
    third_party_reference_number: 'BANK-1',
    status: 'success',
    amount: '50000.00',
    charges: '0.00',
    channel: 'bank_transfer',
    created_at: '2026-05-07T10:30:00Z',
    account_number: '7801234567',
    sender_account_number: '0123456789',
    sender_account_name: 'John Doe',
    bank_name: 'Access Bank',
    transaction_type: 'credit',
    session_id: 'S-13',
  };
  it('reads the webhook field names', () => {
    expect(parseCollection(raw)).toEqual({
      transactionId: raw.transaction_id,
      referenceNumber: 'TXN-1',
      sessionId: 'S-13',
      status: 'success',
      amount: '50000.00',
      fee: '0.00',
      channel: 'bank_transfer',
      createdAt: '2026-05-07T10:30:00Z',
      accountNumber: '7801234567',
      transactionType: 'credit',
      payerName: 'John Doe',
      payerBankName: 'Access Bank',
      payerAccountMasked: '******6789',
    });
  });
  it('accepts "id" for the transaction id and number amounts', () =>
    expect(parseCollection({ ...raw, transaction_id: undefined, id: 't9', amount: 100 })).toMatchObject({ transactionId: 't9', amount: '100' }));
  it('refuses a row with no id or a bad amount', () => {
    expect(parseCollection({ ...raw, transaction_id: undefined })).toBeNull();
    expect(parseCollection({ ...raw, amount: 'abc' })).toBeNull();
    expect(parseCollection({ ...raw, amount: '-5' })).toBeNull();
    expect(parseCollection(null)).toBeNull();
  });
  it('a missing fee is null, not zero, and status is lower case', () =>
    expect(parseCollection({ ...raw, charges: undefined, status: 'SUCCESS' })).toMatchObject({ fee: null, status: 'success' }));
});
