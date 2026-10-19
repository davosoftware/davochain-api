import { FlutterwaveRail } from './flutterwave-rail';
import { RailRefusedError, RailUnknownError } from './naira-rail';
import { FlutterwaveError, FlutterwaveUnknownError } from '../flutterwave/flutterwave.errors';
import { dec } from '../common/money';

function build(over: Record<string, jest.Mock> = {}) {
  const client = {
    getBalance: jest.fn(async () => ({ currency: 'NGN', available_balance: '1500000.50', ledger_balance: '1600000' })),
    listBanks: jest.fn(async () => [{ id: 1, code: '044', name: 'Access Bank' }]),
    resolveAccount: jest.fn(async () => ({ account_number: '0123456789', account_name: 'ADA OKAFOR' })),
    createTransfer: jest.fn(async () => ({ id: 991, reference: 'trsy_1', status: 'NEW', fee: 10.75, complete_message: '' })),
    getTransferByReference: jest.fn(async () => null),
    ...over,
  };
  return { rail: new FlutterwaveRail(client as never), client };
}

describe('FlutterwaveRail: Flutterwave behind the naira rail plug', () => {
  it('reads our naira balance', async () => {
    const b = await build().rail.balance();
    expect(b.available.eq(dec('1500000.50'))).toBe(true);
    expect(b.ledger.eq(dec('1600000'))).toBe(true);
  });

  it('lists banks and looks up an account name', async () => {
    const { rail } = build();
    await expect(rail.banks()).resolves.toEqual([{ code: '044', name: 'Access Bank' }]);
    await expect(rail.resolveAccount({ bankCode: '044', accountNumber: '0123456789' })).resolves.toEqual({ accountName: 'ADA OKAFOR' });
  });

  it('sends a transfer with our reference, in naira, and maps the answer', async () => {
    const { rail, client } = build();
    const t = await rail.transfer({ reference: 'trsy_1', bankCode: '044', accountNumber: '0123456789', amount: dec('25000'), narration: 'DavoChain treasury' });
    expect(client.createTransfer).toHaveBeenCalledWith({
      account_bank: '044', account_number: '0123456789', amount: 25000, narration: 'DavoChain treasury', currency: 'NGN', reference: 'trsy_1', debit_currency: 'NGN',
    });
    expect(t).toMatchObject({ id: '991', reference: 'trsy_1', status: 'PENDING', reason: null });
    expect(t.fee?.eq(dec('10.75'))).toBe(true);
  });

  it.each([
    ['SUCCESSFUL', 'SUCCESSFUL'],
    ['FAILED', 'FAILED'],
    ['PENDING', 'PENDING'],
    ['NEW', 'PENDING'],
  ])('maps a %s transfer to %s', async (from, to) => {
    const { rail } = build({ getTransferByReference: jest.fn(async () => ({ id: 5, reference: 'r', status: from, fee: null, complete_message: 'Insufficient funds' })) });
    const t = await rail.transferStatus('r');
    expect(t?.status).toBe(to);
    if (to === 'FAILED') expect(t?.reason).toBe('Insufficient funds');
  });

  it('a transfer it cannot find is null', async () => {
    await expect(build().rail.transferStatus('nope')).resolves.toBeNull();
  });

  it('a definite refusal is RailRefusedError (safe to refund); anything unclear is RailUnknownError (never refund)', async () => {
    const refused = build({ createTransfer: jest.fn(async () => { throw new FlutterwaveError('DEFINITE', 'Account is not valid', 400); }) });
    await expect(refused.rail.transfer({ reference: 'r', bankCode: '044', accountNumber: '1', amount: dec('1'), narration: 'n' })).rejects.toBeInstanceOf(RailRefusedError);
    const unclear = build({ createTransfer: jest.fn(async () => { throw new FlutterwaveUnknownError('timeout', 'POST', '/transfers'); }) });
    await expect(unclear.rail.transfer({ reference: 'r', bankCode: '044', accountNumber: '1', amount: dec('1'), narration: 'n' })).rejects.toBeInstanceOf(RailUnknownError);
    const other = build({ createTransfer: jest.fn(async () => { throw new Error('socket hang up'); }) });
    await expect(other.rail.transfer({ reference: 'r', bankCode: '044', accountNumber: '1', amount: dec('1'), narration: 'n' })).rejects.toBeInstanceOf(RailUnknownError);
  });
});
