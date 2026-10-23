import type { StatusAnswer, TransferAnswer } from './payrep.classify';
import type { PayrepAccount, PayrepBank, PayrepCollection, PayrepCursor, PayrepCustomerAccount, PayrepNameEnquiry, PayrepRecentAccount, PayrepTransferInput } from './payrep.types';

/**
 * The seam everything depends on; PayrepModule binds the real client or the mock.
 * Reads throw PayrepError. transfer() and transactionStatus() never throw: they
 * return the classified answer, so "unclear" can't be mistaken for "refused".
 */
export abstract class PayrepApi {
  abstract banks(): Promise<PayrepBank[]>;
  abstract nameEnquiry(i: { accountNumber: string; bankCode: string }): Promise<PayrepNameEnquiry>;
  abstract account(accountNumber: string): Promise<PayrepAccount>;
  abstract transfer(i: PayrepTransferInput): Promise<TransferAnswer>;
  abstract transactionStatus(reference: string): Promise<StatusAnswer>;
  abstract createCustomerAccount(i: { bvn?: string; nin?: string; phoneNumber?: string; poolAccountNumber: string }): Promise<PayrepCustomerAccount>;
  /**
   * create_account (spec 2026-10-23): an account under our business, pooled into
   * our main account, named after the customer. No BVN or NIN. NOT idempotent:
   * throws PayrepError; UNCLEAR means "look in recentAccounts before sending again".
   */
  abstract createAccount(i: { accountName: string; poolAccountNumber: string }): Promise<PayrepCustomerAccount>;
  /** Accounts created since `since`, newest first; null when the list can't be read (never a silent []). */
  abstract recentAccounts(i: { since: Date }): Promise<PayrepRecentAccount[] | null>;
  abstract fetchCredits(
    f: { accountNumber?: string; referenceNumber?: string; startDate: string; endDate: string },
    cursor?: PayrepCursor | null,
  ): Promise<{ items: PayrepCollection[]; next: PayrepCursor | null }>;
}
