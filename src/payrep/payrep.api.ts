import type { StatusAnswer, TransferAnswer } from './payrep.classify';
import type { PayrepAccount, PayrepBank, PayrepCollection, PayrepCursor, PayrepCustomerAccount, PayrepNameEnquiry, PayrepTransferInput } from './payrep.types';

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
  abstract fetchCredits(
    f: { accountNumber?: string; referenceNumber?: string; startDate: string; endDate: string },
    cursor?: PayrepCursor | null,
  ): Promise<{ items: PayrepCollection[]; next: PayrepCursor | null }>;
}
