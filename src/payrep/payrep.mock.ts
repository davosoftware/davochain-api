import { createHash, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { request } from 'undici';
import { PayrepApi } from './payrep.api';
import { MOCK_WEBHOOK_SECRET } from './payrep.config';
import type { StatusAnswer, TransferAnswer } from './payrep.classify';
import { PayrepError } from './payrep.errors';
import { payrepSignature } from './webhook-signature';
import type { PayrepAccount, PayrepBank, PayrepCollection, PayrepCustomerAccount, PayrepNameEnquiry, PayrepTransferInput } from './payrep.types';

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
  async simulateDeposit(i: { accountNumber: string; amount: string; senderName?: string; status?: 'success' | 'pending' | 'failed'; fee?: string }) {
    const status = i.status ?? 'success';
    const c: StoredCredit = {
      event: `deposit.${status}`,
      transactionId: randomUUID(),
      referenceNumber: `MOCKREF${Date.now()}${Math.floor(Math.random() * 1000)}`,
      sessionId: `MOCKSESSION${Date.now()}`,
      status,
      amount: i.amount,
      fee: i.fee ?? '0.00',
      channel: 'bank_transfer',
      createdAt: new Date().toISOString(),
      accountNumber: i.accountNumber,
      transactionType: 'credit',
      payerName: i.senderName ?? 'MOCK SENDER',
      payerBankName: 'Access Bank',
      payerAccountMasked: '******6789',
    };
    this.credits.push(c);
    return { transactionId: c.transactionId, webhookStatus: await this.deliver(c) };
  }

  /** Sends the same deposit's webhook again, with a new X-Timestamp and X-Webhook-Id (as Payrep's retries do). */
  async redeliver(transactionId: string): Promise<number | null> {
    const c = this.credits.find((x) => x.transactionId === transactionId);
    return c ? this.deliver(c) : null;
  }

  private async deliver(c: StoredCredit): Promise<number | null> {
    const raw = JSON.stringify({
      event: c.event,
      data: {
        transaction_id: c.transactionId,
        reference_number: c.referenceNumber,
        status: c.status,
        amount: c.amount,
        charges: c.fee,
        channel: c.channel,
        created_at: c.createdAt,
        account_number: c.accountNumber,
        sender_account_name: c.payerName,
        sender_account_number: '0123456789',
        bank_name: c.payerBankName,
      },
    });
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
