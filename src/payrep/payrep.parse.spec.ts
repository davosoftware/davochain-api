import { collectionKey, listOf, parseCollection } from './payrep.parse';

describe('listOf: fetch_transactions has no documented response shape (Review Focus 2)', () => {
  it.each([[[{ a: 1 }]], [{ results: [{ a: 1 }] }], [{ transactions: [{ a: 1 }] }], [{ data: [{ a: 1 }] }], [{ items: [{ a: 1 }] }]])(
    'finds the list in %j',
    (data) => expect(listOf(data)).toEqual([{ a: 1 }]),
  );
  it('no data at all is an empty list', () => {
    expect(listOf(null)).toEqual([]);
    expect(listOf(undefined)).toEqual([]);
  });
  it('a shape it does not recognise is null ("unreadable"), never an empty list (final review I2)', () => {
    expect(listOf({ nothing: true })).toBeNull();
    expect(listOf({ data: { results: [{ a: 1 }] } })).toBeNull();
    expect(listOf({ records: [{ a: 1 }] })).toBeNull();
    expect(listOf('x')).toBeNull();
  });
});

/**
 * The shapes the Payrep SANDBOX really returns (seen 22 Oct 2026; values made up).
 * They differ from Payrep's docs: no transaction_id, our account in account__account_number,
 * the sender in source_* (list) or sender_* (webhook), and amounts as numbers in the list.
 */
const SANDBOX_LIST_ITEM = {
  reference_number: 'PRP-REF-0001', third_party_reference_number: '000013251022120000', session_id: null, parent_transaction: null,
  account_id: 'b1c2d3e4-0000-0000-0000-000000000000', account__customer_id: 'c1', account__customer__name: 'DAVOCHAIN LTD',
  account__account_number: '2012345678', account__account_name: 'DAVOCHAIN/ADA OBI', amount: 5000, charges: 0, transaction_type: 'credit',
  transfer_type: 'inter', source_account_number: '0123456789', source_account_name: 'ADA OBI', beneficiary_account_number: '2012345678',
  beneficiary_account_name: 'DAVOCHAIN/ADA OBI', bank_code: '090823', bank_name: 'Sandbox Bank', source_bank_code: '044', source_bank_name: 'Access Bank',
  remarks: 'fund', status: 'successful', response_code: '00', is_reversal: false, is_reversed: false, notification_sent: true, has_dispute: false,
  created_at: '2026-10-22T10:00:00.000000+01:00', channel: 'bank_transfer', transaction_category: 'collection',
};
const SANDBOX_WEBHOOK_PAYLOAD = {
  amount: '5000.00', status: 'successful', channel: 'webhook', charges: '0.00', remarks: 'fund', bank_code: '', bank_name: '',
  created_at: '2026-10-22T10:00:00.000000+01:00', session_id: null, is_reversal: false, account_name: '', account_number: '2012345678',
  reference_number: null, sender_bank_code: '044', sender_bank_name: 'Access Bank', transaction_type: 'credit', sender_account_name: 'ADA OBI',
  sender_account_number: '0123456789', third_party_reference_number: '000013251022120000',
};

describe('the real sandbox shapes', () => {
  it('a list item is read: the bank reference is the id, our account and the sender come from the sandbox field names', () => {
    expect(parseCollection(SANDBOX_LIST_ITEM)).toEqual({
      transactionId: '000013251022120000', referenceNumber: 'PRP-REF-0001', sessionId: null, status: 'successful', amount: '5000', fee: '0',
      channel: 'bank_transfer', createdAt: '2026-10-22T10:00:00.000000+01:00', accountNumber: '2012345678', transactionType: 'credit',
      payerName: 'ADA OBI', payerBankName: 'Access Bank', payerAccountMasked: '******6789', payerAccountNumber: '0123456789', payerBankCode: '044',
    });
  });
  it('the webhook payload gives the SAME id as the list item, so a deposit can be confirmed', () => {
    expect(collectionKey(SANDBOX_WEBHOOK_PAYLOAD)).toBe(parseCollection(SANDBOX_LIST_ITEM)!.transactionId);
    expect(parseCollection(SANDBOX_WEBHOOK_PAYLOAD)).toMatchObject({ transactionId: '000013251022120000', accountNumber: '2012345678', payerName: 'ADA OBI', payerBankName: 'Access Bank' });
  });
  // A simulated deposit into a customer account (sandbox, 22 Oct 2026) is listed against our MAIN pool
  // account; the customer's account is beneficiary_account_number, and the account filter doesn't find it.
  it('a collection: the account paid is the beneficiary, not the pool account the item is filed under', () => {
    const collection = {
      ...SANDBOX_LIST_ITEM,
      account__account_number: '7801231424', beneficiary_account_number: '6077165401', beneficiary_account_name: '',
      bank_code: '', bank_name: '', transaction_type: 'credit', transfer_type: 'inter', channel: 'webhook', transaction_category: 'collection',
    };
    expect(parseCollection(collection)).toMatchObject({ accountNumber: '6077165401', payerName: 'ADA OBI', payerBankName: 'Access Bank' });
    // A debit still names the account it left from.
    expect(parseCollection({ ...collection, transaction_type: 'debit' })?.accountNumber).toBe('7801231424');
  });
  it('a reversed item reads as reversed', () => expect(parseCollection({ ...SANDBOX_LIST_ITEM, is_reversed: true })?.status).toBe('reversed'));
  it('the id falls back to reference_number, then transaction_id', () => {
    expect(collectionKey({ reference_number: 'R1', transaction_id: 'T1' })).toBe('R1');
    expect(collectionKey({ transaction_id: 'T1' })).toBe('T1');
    expect(collectionKey({})).toBeNull();
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
  it('reads the documented webhook field names; the bank reference is the id', () => {
    expect(parseCollection(raw)).toEqual({
      transactionId: 'BANK-1',
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
      payerAccountNumber: '0123456789',
      payerBankCode: null,
    });
  });
  it('accepts "id" for the transaction id and number amounts', () =>
    expect(parseCollection({ ...raw, third_party_reference_number: undefined, reference_number: undefined, transaction_id: undefined, id: 't9', amount: 100 })).toMatchObject({ transactionId: 't9', amount: '100' }));
  it('refuses a row with no id or a bad amount', () => {
    expect(parseCollection({ ...raw, transaction_id: undefined, third_party_reference_number: undefined, reference_number: undefined })).toBeNull();
    expect(parseCollection({ ...raw, amount: 'abc' })).toBeNull();
    expect(parseCollection({ ...raw, amount: '-5' })).toBeNull();
    expect(parseCollection(null)).toBeNull();
  });
  it('a missing fee is null, not zero, and status is lower case', () =>
    expect(parseCollection({ ...raw, charges: undefined, status: 'SUCCESS' })).toMatchObject({ fee: null, status: 'success' }));
});
