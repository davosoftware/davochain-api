import { QuidaxError } from './quidax.errors';
import { QuidaxMockClient } from './quidax.mock';

function client() {
  const config = {
    getOrThrow: () => 'https://openapi.quidax.io/exchange-open-api/api/v1',
    get: () => undefined,
  };
  return new QuidaxMockClient(config as never, {} as never);
}

describe('QuidaxMockClient NGN bank withdrawals', () => {
  it('returns Nigerian NGN banks and resolves a bank account without moving funds', async () => {
    const quidax = client();

    await expect(quidax.fetchBanks()).resolves.toEqual([
      { code: '0000', name: 'Test Bank', country: 'Nigeria', currency: 'NGN' },
      { code: '100004', name: 'Paycom (Opay)', country: 'Nigeria', currency: 'NGN' },
    ]);
    await expect(
      quidax.verifyBankAccount({ accountNumber: '0123456789', bankCode: '0000' }),
    ).resolves.toEqual({ account_name: 'MOCK ACCOUNT 6789' });
    await expect(
      quidax.verifyBankAccount({ accountNumber: 'not-a-number', bankCode: '0000' }),
    ).rejects.toBeInstanceOf(QuidaxError);
  });

  it('debits the main NGN wallet and can reconcile the payout by reference', async () => {
    const quidax = client();
    const before = Number((await quidax.fetchWallet('ngn', 'me')).balance);

    const withdrawal = await quidax.createNgnBankWithdrawal({
      amount: '1250.00',
      accountNumber: '0123456789',
      bankCode: '0000',
      reference: 'dvc_ngnwd_test-1',
    });

    expect(withdrawal.type).toBe('bank_account');
    expect(withdrawal.currency).toBe('ngn');
    expect(withdrawal.status).toBe('processing');
    expect(withdrawal.reference).toBe('dvc_ngnwd_test-1');
    expect(Number((await quidax.fetchWallet('ngn', 'me')).balance)).toBe(before - 1250);
    await expect(quidax.fetchWithdrawalByReference('dvc_ngnwd_test-1', 'me')).resolves.toEqual(
      withdrawal,
    );
    await expect(quidax.fetchWithdrawalByReference('dvc_ngnwd_test-1', 'another-account')).resolves.toBeNull();
  });
});