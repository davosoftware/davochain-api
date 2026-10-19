/**
 * Flutterwave v3 shapes, as parsed by parseJsonExact: every JSON number
 * arrives as its exact source text. Money is a `Money` string — turn it into a
 * Decimal, never a JS number. Ids are strings too.
 */
export type Money = string;

export interface FlwPageInfo {
  total?: string;
  current_page?: string;
  total_pages?: string;
  page_size?: string;
}

export interface FlwEnvelope<T> {
  status: string;
  message?: string;
  data?: T;
  meta?: { page_info?: FlwPageInfo } | null;
}

export interface FlwStaticAccount {
  response_code?: string;
  response_message?: string;
  flw_ref?: string;
  order_ref: string;
  account_number: string;
  account_status?: string;
  bank_name: string;
  created_at?: string;
  expiry_date?: string;
  note?: string;
  amount?: string;
}

export interface FlwTransactionMeta {
  virtualaccountnumber?: string;
  originatorname?: string;
  bankname?: string;
  bankcode?: string;
  originatoraccountnumber?: string;
  originatoramount?: string;
}

export interface FlwTransaction {
  id: string;
  tx_ref?: string | null;
  flw_ref?: string | null;
  amount?: Money | null;
  charged_amount?: Money | null;
  app_fee?: Money | null;
  merchant_fee?: Money | null;
  amount_settled?: Money | null;
  currency?: string | null;
  status?: string | null;
  payment_type?: string | null;
  narration?: string | null;
  processor_response?: string | null;
  created_at?: string | null;
  meta?: FlwTransactionMeta | null;
}

export interface FlwBalance {
  currency: string;
  available_balance: Money;
  ledger_balance: Money;
}

/** GET /banks/NG */
export interface FlwBank {
  id: number | string;
  code: string;
  name: string;
}

/** POST /accounts/resolve */
export interface FlwResolvedAccount {
  account_number: string;
  account_name: string;
}

/** POST /transfers body (naira payout to a Nigerian bank account). */
export interface CreateTransferInput {
  account_bank: string;
  account_number: string;
  amount: number;
  narration: string;
  currency: 'NGN';
  reference: string;
  debit_currency: 'NGN';
}

/** A transfer, as POST /transfers and GET /transfers return it. status: NEW | PENDING | SUCCESSFUL | FAILED. */
export interface FlwTransfer {
  id: number | string;
  reference: string;
  status: string;
  amount?: number | Money;
  fee?: number | Money | null;
  complete_message?: string | null;
}

export interface CreateStaticAccountInput {
  email: string;
  txRef: string;
  firstName: string;
  lastName: string;
  /** The name a payer sees when they type the account number. */
  narration: string;
  /** Exactly one of bvn / nin. Never logged or stored. */
  bvn?: string;
  nin?: string;
}

export interface ListTransactionsQuery {
  /** YYYY-MM-DD */
  from: string;
  /** YYYY-MM-DD */
  to: string;
  page: number;
  status?: string;
  currency?: string;
}
