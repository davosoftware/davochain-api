import { QuidaxError } from '../../quidax/quidax.errors';
import { RailRefusedError, RailUnknownError } from '../../naira-rail/naira-rail';

/**
 * Test helper: a naira rail built from an older spec's fake Quidax bank calls,
 * so those specs keep checking the same behaviour now that banks, names and
 * payouts come from the naira rail (H11).
 */
export function railFromQuidax(quidax: {
  fetchBanks?: () => Promise<Array<{ code: string; name: string; country: string; currency: string }>>;
  verifyBankAccount?: (i: { accountNumber: string; bankCode: string }) => Promise<{ account_name: string }>;
}) {
  return {
    name: 'Flutterwave',
    banks: async () =>
      ((await quidax.fetchBanks?.()) ?? [])
        .filter((b) => b.country.toLowerCase() === 'nigeria' && b.currency.toLowerCase() === 'ngn')
        .map(({ code, name }) => ({ code, name })),
    resolveAccount: async (i: { accountNumber: string; bankCode: string }) => {
      try {
        return { accountName: (await quidax.verifyBankAccount!(i)).account_name };
      } catch (err) {
        if (err instanceof QuidaxError && err.httpStatus >= 400 && err.httpStatus < 500) throw new RailRefusedError(err.message);
        throw new RailUnknownError((err as Error).message);
      }
    },
    transfer: jest.fn(async (i: { reference: string }) => ({ id: 'rail-1', reference: i.reference, status: 'PENDING', fee: null, reason: null })),
    transferStatus: jest.fn(async () => null),
    balance: jest.fn(),
  };
}
