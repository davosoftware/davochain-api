export interface PayrepBank {
  name: string;
  /** NIP code (6 digits), what transfers and name enquiry take. */
  code: string;
  cbnCode: string | null;
}

export interface PayrepNameEnquiry {
  accountNumber: string;
  accountName: string;
  bankCode: string;
  bankName: string;
  transferType: 'intra' | 'inter';
  sessionId: string | null;
}

export interface PayrepAccount {
  accountNumber: string;
  accountName: string;
  status: string;
  balance: string;
}

export interface PayrepCustomerAccount {
  accountNumber: string;
  accountName: string;
  bankName: string;
  status: string;
  providerRef: string | null;
}

export interface PayrepTransferInput {
  reference: string;
  sourceAccountNumber: string;
  sourceAccountName: string;
  beneficiaryAccountNumber: string;
  beneficiaryAccountName: string;
  bankCode: string;
  bankName: string;
  /** Naira with 2 decimals, e.g. "5000.00". */
  amount: string;
  transferType: 'intra' | 'inter';
  remarks: string;
  sessionId: string | null;
}

/** One credit as Payrep reports it. Field names follow the webhook payload; check-payrep confirms them for fetch_transactions. */
export interface PayrepCollection {
  transactionId: string;
  referenceNumber: string | null;
  sessionId: string | null;
  status: string;
  amount: string;
  fee: string | null;
  channel: string | null;
  createdAt: string | null;
  accountNumber: string | null;
  transactionType: string | null;
  payerName: string | null;
  payerBankName: string | null;
  payerAccountMasked: string | null;
}

export interface PayrepCursor {
  createdAt: string;
  id: string;
}
