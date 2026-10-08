import { request } from 'undici';
import { Decimal, dec } from '../common/money';
import { FlutterwaveClient } from './flutterwave.client';
import { FlutterwaveConfig } from './flutterwave.config';
import { FlutterwaveError, redactIds } from './flutterwave.errors';
import type {
  CreateStaticAccountInput,
  FlwBalance,
  FlwStaticAccount,
  FlwTransaction,
  ListTransactionsQuery,
} from './flutterwave.types';

export type MockMethod =
  | 'createStaticVirtualAccount'
  | 'getVirtualAccount'
  | 'setVirtualAccountStatus'
  | 'verifyTransaction'
  | 'listTransactions'
  | 'getBalance';

export interface SimulatePayInInput {
  /** The tx_ref of the virtual account that was paid (dcva_<user>). */
  txRef: string;
  /** Naira, as text: "1500" or "1500.50". */
  amount: string;
  payerName?: string;
  /** Defaults to the account created with this txRef. */
  accountNumber?: string;
  status?: 'successful' | 'pending' | 'failed';
  currency?: string;
  format?: 'legacy' | 'v3';
  /** Deliver the webhook to our own API (default true). Unit tests pass false. */
  sendWebhook?: boolean;
}

/** The sandbox's deposit fee: 1.4%, rounded to kobo, capped at ₦2,000. */
export function mockFee(amount: Decimal): Decimal {
  return Decimal.min(amount.mul('0.014').toDecimalPlaces(2), dec(2000));
}

/**
 * Flutterwave in memory, for development and tests (FLW_USE_MOCK=true).
 *
 * The only network traffic is the webhook it delivers to our own API, so a
 * simulated deposit runs the real intake path: hash check, storage, queue,
 * verify, credit. Amounts follow the sandbox exactly, including the fee.
 *
 * Ids start from the process start time, so a restarted dev server never hands
 * out an id the database has already seen.
 */
export class FlutterwaveMockClient extends FlutterwaveClient {
  private readonly accounts = new Map<string, FlwStaticAccount>();
  /** order_ref → the tx_ref it was created with. */
  private readonly accountTxRefs = new Map<string, string>();
  private readonly transactions = new Map<string, FlwTransaction>();
  private readonly failures = new Map<MockMethod, Error>();
  private readonly runId = Date.now().toString(36).toUpperCase();
  private accountSeq = 0;
  private nextTx = Date.now();

  constructor(cfg: FlutterwaveConfig) {
    super(cfg);
  }

  /** Make the next call to `method` throw `error`. For tests. */
  failNext(method: MockMethod, error: Error): void {
    this.failures.set(method, error);
  }

  /** Make verify return exactly this. For tests that need an answer simulatePayIn won't give. */
  seedTransaction(tx: FlwTransaction): void {
    this.transactions.set(tx.id, structuredClone(tx));
  }

  private maybeFail(method: MockMethod): void {
    const error = this.failures.get(method);
    if (error) {
      this.failures.delete(method);
      throw error;
    }
  }

  async createStaticVirtualAccount(input: CreateStaticAccountInput): Promise<FlwStaticAccount> {
    this.maybeFail('createStaticVirtualAccount');
    if (!input.bvn === !input.nin) {
      throw new FlutterwaveError('DEFINITE', 'BVN or NIN is required for static account number', 400);
    }
    const n = ++this.accountSeq;
    const account: FlwStaticAccount = {
      response_code: '02',
      response_message: 'Transaction in progress',
      flw_ref: `MockFLWRef-${this.runId}-${n}`,
      order_ref: `URF_MOCK_${this.runId}_${n}`,
      account_number: String(9_000_000_000 + ((Date.now() + n) % 1_000_000_000)),
      account_status: 'active',
      bank_name: 'Flutterwave MFB (mock)',
      created_at: new Date().toISOString(),
      expiry_date: 'N/A',
      note: `Please make a bank transfer to ${input.narration}`,
      amount: '0.00',
    };
    this.accounts.set(account.order_ref, account);
    this.accountTxRefs.set(account.order_ref, input.txRef);
    return { ...account };
  }

  async getVirtualAccount(orderRef: string): Promise<FlwStaticAccount> {
    this.maybeFail('getVirtualAccount');
    const account = this.accounts.get(orderRef);
    if (!account) throw new FlutterwaveError('NOT_FOUND', 'Virtual account not found', 404);
    return { ...account };
  }

  async setVirtualAccountStatus(orderRef: string, status: 'active' | 'inactive'): Promise<void> {
    this.maybeFail('setVirtualAccountStatus');
    const account = this.accounts.get(orderRef);
    if (!account) throw new FlutterwaveError('NOT_FOUND', 'Virtual account not found', 404);
    account.account_status = status;
  }

  async verifyTransaction(id: string): Promise<FlwTransaction> {
    this.maybeFail('verifyTransaction');
    const tx = this.transactions.get(id);
    if (!tx) throw new FlutterwaveError('NOT_FOUND', 'No transaction was found for this id', 400);
    return structuredClone(tx);
  }

  async listTransactions(q: ListTransactionsQuery): Promise<{ items: FlwTransaction[]; totalPages: number }> {
    this.maybeFail('listTransactions');
    const all = [...this.transactions.values()].filter(
      (t) => (!q.status || t.status === q.status) && (!q.currency || t.currency === q.currency),
    );
    const pageSize = 10;
    return {
      items: all.slice((q.page - 1) * pageSize, q.page * pageSize).map((t) => structuredClone(t)),
      totalPages: Math.ceil(all.length / pageSize),
    };
  }

  async getBalance(currency: string): Promise<FlwBalance> {
    this.maybeFail('getBalance');
    return { currency: currency.toUpperCase(), available_balance: '0', ledger_balance: '0' };
  }

  /** A customer's transfer into a virtual account. Returns Flutterwave's transaction id. */
  async simulatePayIn(input: SimulatePayInInput): Promise<{ id: string; webhookStatus: number | null }> {
    const amount = dec(input.amount);
    const fee = mockFee(amount);
    const id = String(this.nextTx++);
    const orderRef = [...this.accountTxRefs.entries()].find(([, ref]) => ref === input.txRef)?.[0];
    const account = orderRef ? this.accounts.get(orderRef) : undefined;
    const tx: FlwTransaction = {
      id,
      tx_ref: input.txRef,
      flw_ref: `MOCKSESSION${id}`,
      amount: amount.toFixed(),
      charged_amount: amount.toFixed(),
      app_fee: fee.toFixed(),
      merchant_fee: '0',
      amount_settled: amount.minus(fee).toFixed(),
      currency: input.currency ?? 'NGN',
      status: input.status ?? 'successful',
      payment_type: 'bank_transfer',
      narration: 'Mock transfer',
      processor_response: 'success',
      created_at: new Date().toISOString(),
      meta: {
        virtualaccountnumber: input.accountNumber ?? account?.account_number ?? '0000000000',
        originatorname: input.payerName ?? 'MOCK SENDER',
        bankname: 'Mock Bank',
        bankcode: '000',
        originatoraccountnumber: '123*******90',
        originatoramount: 'N/A',
      },
    };
    this.transactions.set(id, tx);
    const webhookStatus =
      input.sendWebhook === false ? null : await this.deliverWebhook(tx, input.format ?? 'legacy');
    return { id, webhookStatus };
  }

  /** Send a stored payment's webhook again, as Flutterwave's retries do. */
  async redeliverWebhook(id: string, format: 'legacy' | 'v3' = 'legacy'): Promise<number | null> {
    const tx = this.transactions.get(id);
    if (!tx) throw new FlutterwaveError('NOT_FOUND', 'No transaction was found for this id', 400);
    return this.deliverWebhook(tx, format);
  }

  /** The HTTP status our endpoint answered, or null when it could not be reached. */
  private async deliverWebhook(tx: FlwTransaction, format: 'legacy' | 'v3'): Promise<number | null> {
    const hash = await this.cfg.secretHash();
    // Numbers here mimic Flutterwave's JSON. They are webhook hints only and
    // never feed money: crediting reads the verify answer, which stays exact text.
    const body =
      format === 'v3'
        ? {
            event: 'charge.completed',
            data: {
              id: Number(tx.id),
              tx_ref: tx.tx_ref,
              flw_ref: tx.flw_ref,
              amount: Number(tx.amount),
              currency: tx.currency,
              status: tx.status,
              payment_type: tx.payment_type,
            },
            'event.type': 'BANK_TRANSFER_TRANSACTION',
          }
        : {
            id: Number(tx.id),
            txRef: tx.tx_ref,
            flwRef: tx.flw_ref,
            amount: Number(tx.amount),
            charged_amount: Number(tx.charged_amount),
            status: tx.status,
            currency: tx.currency,
            appfee: Number(tx.app_fee),
            merchantfee: 0,
            merchantbearsfee: 1,
            'event.type': 'BANK_TRANSFER_TRANSACTION',
          };
    try {
      const res = await request(`http://127.0.0.1:${this.cfg.port}/webhooks/flutterwave`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'verif-hash': hash ?? '' },
        body: JSON.stringify(body),
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
      });
      await res.body.text();
      this.log.log(`Mock webhook for ${tx.id} delivered → ${res.statusCode}`);
      return res.statusCode;
    } catch (err) {
      this.log.warn(`Mock webhook for ${tx.id} not delivered: ${redactIds((err as Error).message)}`);
      return null;
    }
  }
}
