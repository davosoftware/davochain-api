/** Every Quidax response is this shape. Never trust the HTTP status alone. */
export interface QuidaxEnvelope<T> {
  status: 'success' | 'error';
  message: string;
  data: T;
}

export interface QuidaxErrorBody {
  code: string; // E0107, E0604 …
  message: string;
}

export interface QuidaxUser {
  id: string | null; // NULL on some webhooks — fall back to `sn`
  sn: string;
  email: string;
  reference: string | null;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuidaxNetwork {
  id: string; // bep20, trc20, arbitrum …
  name: string;
  deposits_enabled: boolean;
  withdraws_enabled: boolean;
}

export interface QuidaxWallet {
  id: string;
  name: string;
  currency: string;
  balance: string;
  locked: string;
  staked: string;
  converted_balance: string;
  reference_currency: string;
  is_crypto: boolean;
  blockchain_enabled: boolean;
  default_network?: string | null;
  /** The authoritative chain list. Two published doc pages disagree; this does not. */
  networks?: QuidaxNetwork[];
  deposit_address: string | null;
  destination_tag: string | null;
}

export interface QuidaxPaymentAddress {
  id: string;
  reference: string | null;
  currency: string;
  address: string | null; // NULL on create — generation is async
  network: string | null;
  destination_tag: string | null;
  total_payments: string | null;
  created_at: string;
  updated_at: string;
  user?: QuidaxUser | null;
}

export interface QuidaxSwapQuotation {
  id: string;
  confirmed: boolean;
  from_currency: string;
  to_currency: string;
  quoted_price: string;
  quoted_currency?: string;
  from_amount: string;
  to_amount: string;
  expires_at: string; // ~15 seconds out
  created_at: string;
  updated_at: string;
  user?: QuidaxUser;
}

export interface QuidaxSwapTransaction {
  id: string;
  from_currency: string;
  to_currency: string;
  from_amount: string;
  received_amount: string;
  execution_price: string;
  status: 'initiated' | 'completed' | 'failed' | string;
  created_at: string;
  updated_at: string;
  swap_quotation?: QuidaxSwapQuotation;
  user?: QuidaxUser;
}

export interface QuidaxWithdrawal {
  id: string;
  reference: string | null;
  type: 'coin_address' | 'internal' | 'bank_account' | string;
  currency: string;
  amount: string;
  fee: string;
  total: string;
  txid?: string | null;
  status: string; // "done" | "processing" | "rejected" — case varies by endpoint
  reason?: string | null;
  created_at?: string;
  done_at?: string | null;
}

export interface QuidaxDeposit {
  id: string;
  type: string;
  currency: string;
  amount: string;
  fee: string;
  txid: string | null;
  status: string; // submitted | accepted | on_hold | rejected | failed_aml …
  reason: string | null;
  created_at: string;
  done_at: string | null;
  wallet?: QuidaxWallet;
  user?: QuidaxUser;
  payment_transaction?: {
    status: string;
    confirmations: number;
    required_confirmations: number;
  };
  payment_address?: QuidaxPaymentAddress;
}

export interface QuidaxFeeRule {
  fee: number;
  type: string;
}

/** Header-based cursor. Quidax does NOT put pagination in the body. */
export interface QuidaxPage<T> {
  data: T;
  nextPage: string | null;
  totalPages: number | null;
  perPage: number | null;
  page: number | null;
}

export type QuidaxWebhookEventName =
  | 'wallet.address.generated'
  | 'wallet.updated'
  | 'deposit.transaction.confirmation'
  | 'deposit.successful'
  | 'deposit.on_hold'
  | 'deposit.failed_aml'
  | 'deposit.rejected'
  | 'withdraw.successful'
  | 'withdraw.rejected'
  | 'swap_transaction.complete'
  | 'swap_transaction.failed';

export interface QuidaxWebhookPayload<T = unknown> {
  event: QuidaxWebhookEventName | string;
  data: T;
}
