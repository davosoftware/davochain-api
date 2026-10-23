import { createHash, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { request } from 'undici';
import { PayrepApi } from './payrep.api';
import { MOCK_WEBHOOK_SECRET } from './payrep.config';
import type { StatusAnswer, TransferAnswer } from './payrep.classify';
import { PayrepError } from './payrep.errors';
import { payrepSignature } from './webhook-signature';
import type { PayrepAccount, PayrepBank, PayrepCollection, PayrepCustomerAccount, PayrepNameEnquiry, PayrepTransferInput, PayrepRecentAccount } from './payrep.types';

const BANKS: PayrepBank[] = [
  { name: 'Access Bank', code: '000014', cbnCode: '044' },
  { name: 'GTBank', code: '000013', cbnCode: '058' },
  { name: 'Kuda Microfinance Bank', code: '090267', cbnCode: '50211' },
  { name: 'Payrep MFB', code: '090823', cbnCode: null },
];
const kobo = (amount: string) => (amount.split('.')[1] ?? '').padEnd(2, '0').slice(0, 2);
type StoredCredit = PayrepCollection & { event: string };

/**
 * A pretend Payrep for development and test (env validation refuses it
 * anywhere else). It plays every path the sandbox can't show on demand,
 * chosen by the amount's kobo:
 *   .51 refused (insufficient balance)   .77 queued for approval (maker-checker)
 *   .80 duplicate/unavailable (nothing recorded)   .99 answer lost (it DID go through)
 *   .13 fails on the first status check   .98 status check always unavailable
 * BVN/NIN 11111111111 is refused (83); 99999999999 gets no answer.
 */
export class PayrepMock extends PayrepApi {
  private readonly log = new Logger('PayrepMock');
  private readonly transfers = new Map<string, { amount: string; status: 'NEW' | 'SUCCESSFUL' | 'FAILED' }>();
  private readonly credits: StoredCredit[] = [];
  /** Accounts opened with createAccount, oldest first. */
  private readonly opened: PayrepRecentAccount[] = [];

  constructor(private readonly cfg: { port: number }) {
    super();
  }

  async banks(): Promise<PayrepBank[]> {
    return BANKS;
  }

  async nameEnquiry(i: { accountNumber: string; bankCode: string }): Promise<PayrepNameEnquiry> {
    const bank = BANKS.find((b) => b.code === i.bankCode || b.cbnCode === i.bankCode);
    if (!bank || !/^\d{10}$/.test(i.accountNumber) || i.accountNumber.endsWith('0000')) {
      throw new PayrepError('REFUSED', 'Account not found. Please verify the account number and bank code.', 200, '06');
    }
    return {
      accountNumber: i.accountNumber,
      accountName: `MOCK ACCOUNT ${i.accountNumber.slice(-4)}`,
      bankCode: bank.code,
      bankName: bank.name,
      transferType: bank.code === '090823' ? 'intra' : 'inter',
      sessionId: `MOCKSESSION${Date.now()}`,
    };
  }

  async account(accountNumber: string): Promise<PayrepAccount> {
    return { accountNumber, accountName: 'DAVOCHAIN MOCK MAIN', status: 'active', balance: '50000000.00' };
  }

  async transfer(i: PayrepTransferInput): Promise<TransferAnswer> {
    if (this.transfers.has(i.reference)) {
      return { kind: 'UNCLEAR', reason: 'HTTP 200, code 80: Duplicate transaction. This reference number has already been processed.' };
    }
    const k = kobo(i.amount);
    if (k === '51') return { kind: 'REFUSED', reason: 'Insufficient balance' };
    if (k === '77') return { kind: 'QUEUED_FOR_APPROVAL' };
    if (k === '80') return { kind: 'UNCLEAR', reason: 'HTTP 200, code 80: Service unavailable' };
    this.transfers.set(i.reference, { amount: i.amount, status: 'NEW' });
    if (k === '99') return { kind: 'UNCLEAR', reason: 'mock: the answer was lost (the transfer went through)' };
    return { kind: 'SENT', id: randomUUID(), providerStatus: 'pending', fee: i.transferType === 'intra' ? '0.00' : '10.75' };
  }

  async transactionStatus(reference: string): Promise<StatusAnswer> {
    const t = this.transfers.get(reference);
    if (!t) return { kind: 'NOT_FOUND' };
    if (kobo(t.amount) === '98') return { kind: 'UNCLEAR', reason: 'HTTP 200, code 80: Transaction status check unavailable. Please try again later.' };
    if (t.status === 'NEW') t.status = kobo(t.amount) === '13' ? 'FAILED' : 'SUCCESSFUL';
    return { kind: 'FOUND', status: t.status };
  }

  async createCustomerAccount(i: { bvn?: string; nin?: string; phoneNumber?: string; poolAccountNumber: string }): Promise<PayrepCustomerAccount> {
    const id = (i.bvn ?? i.nin ?? '').trim();
    if (id === '11111111111') throw new PayrepError('REFUSED', 'Identity verification failed. Please check the BVN/NIN provided.', 200, '83');
    if (id === '99999999999') throw new PayrepError('UNCLEAR', 'mock: no answer', 0, null);
    // The same identity always gets the same number, like a real static account.
    const n = parseInt(createHash('sha256').update(id).digest('hex').slice(0, 12), 16) % 100_000_000;
    return { accountNumber: `20${String(n).padStart(8, '0')}`, accountName: 'DAVOCHAIN/MOCK CUSTOMER', bankName: 'Payrep MFB', status: 'active', providerRef: `mock-${id.slice(-4)}` };
  }

  /**
   * Like live create_account: a new number on every call (Payrep doesn't stop
   * duplicates), named with our business prefix. A name containing ANSWER LOST
   * opens the account and then answers UNCLEAR, for the lost-answer drill.
   */
  async createAccount(i: { accountName: string; poolAccountNumber: string }): Promise<PayrepCustomerAccount> {
    let accountNumber: string;
    do accountNumber = String(Math.floor(1_000_000_000 + Math.random() * 8_999_999_999));
    while (this.opened.some((a) => a.accountNumber === accountNumber));
    const accountName = `DavoChain-${i.accountName}`;
    this.opened.push({ accountNumber, accountName, createdAt: new Date() });
    if (/ANSWER LOST/i.test(i.accountName)) throw new PayrepError('UNCLEAR', 'mock: the answer was lost (the account was opened)', 0, null);
    return { accountNumber, accountName, bankName: 'Payrep MFB', status: 'active', providerRef: null };
  }

  async recentAccounts(i: { since: Date }): Promise<PayrepRecentAccount[] | null> {
    return this.opened.filter((a) => a.createdAt >= i.since).reverse();
  }

  async fetchCredits(f: { accountNumber?: string; referenceNumber?: string; startDate: string; endDate: string }) {
    const items = this.credits
      .filter((c) => {
        const day = (c.createdAt ?? '').slice(0, 10);
        return (!f.accountNumber || c.accountNumber === f.accountNumber) && (!f.referenceNumber || c.referenceNumber === f.referenceNumber) && day >= f.startDate && day <= f.endDate;
      })
      .map(({ event: _event, ...c }) => c);
    return { items, next: null };
  }

  /** A customer's transfer into one of our accounts, then the signed webhook to our own API. */
  async simulateDeposit(i: { accountNumber: string; amount: string; senderName?: string; status?: 'success' | 'pending' | 'failed'; fee?: string; senderAccount?: string | null }) {
    // As the sandbox does (22 Oct 2026): event "collection.<status>", status "successful",
    // no transaction_id, a null reference_number, and the bank's reference as the only id.
    const status = i.status === 'pending' ? 'pending' : i.status === 'failed' ? 'failed' : 'successful';
    const c: StoredCredit = {
      event: `collection.${i.status ?? 'success'}`,
      transactionId: `MOCKTP${Date.now()}${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`,
      referenceNumber: null,
      sessionId: null,
      status,
      amount: i.amount,
      fee: i.fee ?? '0.00',
      channel: 'bank_transfer',
      createdAt: new Date().toISOString(),
      accountNumber: i.accountNumber,
      transactionType: 'credit',
      payerName: i.senderName ?? 'MOCK SENDER',
      payerBankName: 'Access Bank',
      payerAccountMasked: i.senderAccount === null ? null : '******6789',
      // A held deposit goes back here (Access Bank by its CBN code, as Payrep's list gives it). null = Payrep gave no sender.
      payerAccountNumber: i.senderAccount === undefined ? '0123456789' : i.senderAccount,
      payerBankCode: i.senderAccount === null ? null : '044',
    };
    this.credits.push(c);
    return { transactionId: c.transactionId, webhookStatus: await this.deliver(c) };
  }

  /** Sends the same deposit's webhook again, with a new X-Timestamp and X-Webhook-Id (as Payrep's retries do). */
  async redeliver(transactionId: string): Promise<number | null> {
    const c = this.credits.find((x) => x.transactionId === transactionId);
    return c ? this.deliver(c) : null;
  }

  private deliver(c: StoredCredit): Promise<number | null> {
    return this.post(
      JSON.stringify({
        event: c.event,
        data: {
          amount: c.amount,
          status: c.status,
          channel: 'webhook',
          charges: c.fee,
          remarks: 'mock deposit',
          bank_code: '',
          bank_name: '',
          created_at: c.createdAt,
          session_id: null,
          is_reversal: false,
          account_name: '',
          account_number: c.accountNumber,
          reference_number: null,
          sender_bank_code: '044',
          sender_bank_name: c.payerBankName,
          transaction_type: 'credit',
          sender_account_name: c.payerName,
          sender_account_number: '0123456789',
          third_party_reference_number: c.transactionId,
        },
      }),
    );
  }

  /** Signs and sends one webhook body to our own API, as Payrep does. */
  private async post(raw: string): Promise<number | null> {
    const ts = String(Math.floor(Date.now() / 1000));
    try {
      const res = await request(`http://127.0.0.1:${this.cfg.port}/webhooks/payrep`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-timestamp': ts, 'x-signature': payrepSignature(MOCK_WEBHOOK_SECRET, ts, raw), 'x-webhook-id': randomUUID() },
        body: raw,
      });
      await res.body.text();
      return res.statusCode;
    } catch (err) {
      this.log.warn(`Mock webhook not delivered: ${(err as Error).message}`);
      return null;
    }
  }
}
