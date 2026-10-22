import { Logger } from '@nestjs/common';
import { request } from 'undici';
import { parseJsonExact } from '../common/exact-json';
import { PayrepApi } from './payrep.api';
import { classifyCreateAccount, classifyRead, classifyTransfer, type StatusAnswer, type TransferAnswer } from './payrep.classify';
import { PayrepError } from './payrep.errors';
import { listOf, nextCursorOf, parseCollection } from './payrep.parse';
import type { PayrepAccount, PayrepBank, PayrepCollection, PayrepCursor, PayrepCustomerAccount, PayrepNameEnquiry, PayrepTransferInput } from './payrep.types';
import type { PayrepConfig } from './payrep.config';

type Obj = Record<string, unknown>;
type Reply = { status: number; body: unknown };
const PREFIX = '/api/v1';
const PAGE = 50;
/** How far back a transfer is looked for by its reference. Payouts and Treasury moves are finished well within this. */
const STATUS_LOOKBACK_DAYS = 35;

/** Thrown before a request is sent while Payrep's rate limit lasts: nothing reached Payrep. */
class PausedError extends Error {}

/** A transfer as it appears in Payrep's transaction list. A reversed one counts as failed: the money came back. */
function listedTransferStatus(item: Obj): StatusAnswer {
  if (item.is_reversed === true) return { kind: 'FOUND', status: 'FAILED' };
  const s = str(item.status).toLowerCase();
  if (s === 'successful' || s === 'success') return { kind: 'FOUND', status: 'SUCCESSFUL' };
  if (s === 'failed' || s === 'reversed') return { kind: 'FOUND', status: 'FAILED' };
  if (s === 'pending' || s === 'processing') return { kind: 'FOUND', status: 'PENDING' };
  return { kind: 'UNCLEAR', reason: `Payrep lists the transfer with a status we don't know: "${s || 'none'}"` };
}
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v));

/**
 * The only code that talks to Payrep (spec §3). Money calls are sent once: a
 * resend with the same reference would only meet "Duplicate", which we already
 * treat as unclear. Never logs a body, a BVN/NIN, a key or a token.
 */
export class PayrepClient extends PayrepApi {
  protected log: Pick<Logger, 'log' | 'warn'> = new Logger('PayrepClient');
  private token: { value: string; refreshAt: number } | null = null;
  /** No call goes to Payrep before this time (its rate limit). */
  private pausedUntil = 0;
  private pending: Promise<string> | null = null;
  private readonly timeoutMs: number;

  constructor(
    private readonly cfg: Pick<PayrepConfig, 'baseUrl' | 'credentials' | 'mainAccount'>,
    opts: { timeoutMs?: number } = {},
  ) {
    super();
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async banks(): Promise<PayrepBank[]> {
    const data = await this.read<unknown>('/transaction/transfer/api/fetch_banks', {});
    const list = listOf(data);
    if (!list) throw new PayrepError('UNCLEAR', 'Payrep answered the bank list in a shape we cannot read', 200, '00');
    return list.flatMap((b) => {
      const o = (b ?? {}) as Obj;
      return str(o.code) && str(o.name) ? [{ name: str(o.name), code: str(o.code), cbnCode: str(o.cbn_code) || null }] : [];
    });
  }

  async nameEnquiry(i: { accountNumber: string; bankCode: string }): Promise<PayrepNameEnquiry> {
    const d =
      (await this.read<Obj | null>('/transaction/transfer/api/name_enquiry', {
        beneficiary_account_number: i.accountNumber,
        bank_code: i.bankCode,
        source_account_number: this.cfg.mainAccount ?? '',
      })) ?? {};
    if (!str(d.beneficiary_account_name)) throw new PayrepError('UNCLEAR', 'Name enquiry answered without a name', 200, '00');
    return {
      accountNumber: str(d.beneficiary_account_number) || i.accountNumber,
      accountName: str(d.beneficiary_account_name),
      bankCode: str(d.bank_code) || i.bankCode,
      bankName: str(d.bank_name),
      transferType: str(d.transfer_type) === 'intra' ? 'intra' : 'inter',
      sessionId: str(d.session_id) || null,
    };
  }

  async account(accountNumber: string): Promise<PayrepAccount> {
    const d = (await this.read<Obj | null>('/account/api/get_account_balance', { account_number: accountNumber })) ?? {};
    return { accountNumber: str(d.account_number) || accountNumber, accountName: str(d.account_name), status: str(d.status).toLowerCase(), balance: str(d.balance) || '0' };
  }

  async transfer(i: PayrepTransferInput): Promise<TransferAnswer> {
    const body: Obj = {
      source_account_number: i.sourceAccountNumber,
      source_account_name: i.sourceAccountName,
      beneficiary_account_number: i.beneficiaryAccountNumber,
      beneficiary_account_name: i.beneficiaryAccountName,
      bank_code: i.bankCode,
      bank_name: i.bankName,
      amount: i.amount,
      transfer_type: i.transferType,
      reference_number: i.reference,
      remarks: i.remarks,
      ...(i.sessionId ? { session_id: i.sessionId } : {}),
    };
    try {
      const r = await this.post('/transaction/transfer/api/funds_transfer', body);
      return classifyTransfer(r.status, r.body);
    } catch (err) {
      // Paused before sending: nothing went to Payrep, so this is a clear no and safe to refund.
      if (err instanceof PausedError) return { kind: 'REFUSED', reason: err.message };
      return { kind: 'UNCLEAR', reason: (err as Error).message };
    }
  }

  /**
   * What happened to one of our transfers, read from Payrep's transaction list by our
   * reference. Payrep's transaction_status endpoint is not used: on the sandbox
   * (22 Oct 2026) it answers "SUCCESSFUL" for any reference, even one never sent.
   * Never throws: anything we can't read is UNCLEAR, which never refunds.
   */
  async transactionStatus(reference: string): Promise<StatusAnswer> {
    try {
      const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
      const data = await this.read<unknown>('/transaction/api/fetch_transactions', {
        filters: { reference_number: reference, start_date: day(-STATUS_LOOKBACK_DAYS), end_date: day(1) },
        limit: PAGE,
        page_size: PAGE,
      });
      const list = listOf(data);
      if (!list) return { kind: 'UNCLEAR', reason: 'Payrep answered the transaction list in a shape we cannot read' };
      const ours = list.map((i) => (i ?? {}) as Obj).filter((i) => str(i.reference_number) === reference && str(i.transaction_type).toLowerCase() !== 'credit');
      if (!ours.length) return { kind: 'NOT_FOUND' };
      return listedTransferStatus(ours[0]);
    } catch (err) {
      return { kind: 'UNCLEAR', reason: (err as Error).message };
    }
  }

  async createCustomerAccount(i: { bvn?: string; nin?: string; phoneNumber?: string; poolAccountNumber: string }): Promise<PayrepCustomerAccount> {
    const body: Obj = {
      ...(i.bvn ? { bvn: i.bvn } : { nin: i.nin }),
      ...(i.phoneNumber ? { phone_number: i.phoneNumber } : {}),
      is_pool: true,
      pool_account_number: i.poolAccountNumber,
      is_enabled_business_prefix: true,
    };
    let r: Reply;
    try {
      r = await this.post('/account/api/create_customer_account', body);
    } catch (err) {
      if (err instanceof PausedError) throw new PayrepError('BUSY', err.message, 429, '94');
      throw new PayrepError('UNCLEAR', (err as Error).message, 0, null);
    }
    const a = classifyCreateAccount<Obj>(r.status, r.body);
    if (!a.ok) throw new PayrepError(a.kind === 'TOKEN' ? 'UNCLEAR' : a.kind, a.message, r.status, a.code);
    return {
      accountNumber: str(a.data.account_number),
      accountName: str(a.data.account_name),
      bankName: str(a.data.bank_name) || 'Payrep MFB',
      status: str(a.data.status).toLowerCase(),
      providerRef: str(a.data.shinobi_customer_id) || null,
    };
  }

  async fetchCredits(
    f: { accountNumber?: string; referenceNumber?: string; startDate: string; endDate: string },
    cursor?: PayrepCursor | null,
  ): Promise<{ items: PayrepCollection[]; next: PayrepCursor | null }> {
    const filters: Obj = { transaction_type: 'credit', start_date: f.startDate, end_date: f.endDate };
    if (f.accountNumber) filters.account_number = f.accountNumber;
    if (f.referenceNumber) filters.reference_number = f.referenceNumber;
    // The docs list both limit and page_size; send both so a page is never silently 20.
    const data = await this.read<unknown>('/transaction/api/fetch_transactions', {
      filters,
      limit: PAGE,
      page_size: PAGE,
      ...(cursor ? { cursor_created_at: cursor.createdAt, cursor_id: cursor.id } : {}),
    });
    const raw = listOf(data);
    // An unreadable reply is UNCLEAR: the sweep reports PARTIAL and alerts, and nothing is credited.
    if (!raw) throw new PayrepError('UNCLEAR', 'Payrep answered the transaction list in a shape we cannot read', 200, '00');
    const items = raw.map(parseCollection).filter((c): c is PayrepCollection => c !== null);
    if (items.length < raw.length) this.log.warn(`fetch_transactions: ${raw.length - items.length} of ${raw.length} item(s) had no id or no readable amount and were skipped`);
    const last = (raw[raw.length - 1] ?? {}) as Obj;
    const lastId = str(last.transaction_id ?? last.id);
    const next = nextCursorOf(data) ?? (raw.length >= PAGE && str(last.created_at) && lastId ? { createdAt: str(last.created_at), id: lastId } : null);
    return { items, next };
  }

  // ── plumbing ─────────────────────────────────────────────

  private async read<T>(path: string, body: Obj): Promise<T> {
    let r: Reply;
    try {
      r = await this.post(path, body);
    } catch (err) {
      if (err instanceof PayrepError) throw err;
      throw new PayrepError('UNCLEAR', (err as Error).message, 0, null);
    }
    const a = classifyRead<T>(r.status, r.body);
    if (a.ok) return a.data;
    // A token refused even after one refresh: the next call starts with a fresh one.
    throw new PayrepError(a.kind === 'TOKEN' ? 'UNCLEAR' : a.kind, a.message, r.status, a.code);
  }

  /** One request; on a token problem the token is refreshed and the request resent ONCE. */
  private async post(path: string, body: Obj): Promise<Reply> {
    this.assertNotPaused();
    let res = await this.send(path, body, await this.bearer());
    if (this.tokenProblem(res)) {
      this.token = null;
      res = await this.send(path, body, await this.bearer());
    }
    return res;
  }

  private tokenProblem(r: Reply): boolean {
    const b = (r.body ?? {}) as Obj;
    return r.status === 401 || (str(b.response_code) === '42' && /token/i.test(str(b.message)));
  }

  private async send(path: string, body: Obj, bearer: string | null): Promise<Reply> {
    const started = Date.now();
    const res = await request(this.cfg.baseUrl + PREFIX + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
      headersTimeout: this.timeoutMs,
      bodyTimeout: this.timeoutMs,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.body.text();
    let parsed: unknown;
    try {
      parsed = text ? parseJsonExact(text) : undefined;
    } catch {
      parsed = undefined;
    }
    this.log.log(`POST ${path} → ${res.statusCode} code ${str((parsed as Obj | undefined)?.response_code) || '-'} in ${Date.now() - started}ms`);
    if (res.statusCode === 429 || str((parsed as Obj | undefined)?.response_code) === '94') this.pause(str((parsed as Obj | undefined)?.message));
    return { status: res.statusCode, body: parsed };
  }

  /**
   * Payrep's rate limit locks our key out for a while (sandbox, 22 Oct 2026: HTTP 429, code 94,
   * "try again in 600 seconds"). Calling again early only extends it, and while it lasts every
   * call fails, payouts included. So the whole client stops calling for the time Payrep gives.
   */
  private pause(message: string): void {
    const seconds = Number(/try again in (\d+)\s*second/i.exec(message)?.[1]) || 60;
    const until = Date.now() + Math.min(seconds, 15 * 60) * 1000;
    if (until > this.pausedUntil) {
      this.pausedUntil = until;
      this.log.warn(`Payrep rate limit reached: no calls for ${Math.round((until - Date.now()) / 1000)}s`);
    }
  }

  private assertNotPaused(): void {
    const left = Math.ceil((this.pausedUntil - Date.now()) / 1000);
    if (left > 0) throw new PausedError(`Payrep asked us to slow down (rate limit): nothing was sent; calls resume in ${left}s`);
  }

  private async bearer(): Promise<string> {
    if (this.token && Date.now() < this.token.refreshAt) return this.token.value;
    this.pending ??= this.fetchToken().finally(() => (this.pending = null));
    return this.pending;
  }

  private async fetchToken(): Promise<string> {
    const { clientId, clientSecret } = await this.cfg.credentials();
    let r: Reply;
    try {
      r = await this.send('/security/api/generate_token', { client_id: clientId, client_secret: clientSecret }, null);
    } catch (err) {
      throw new PayrepError('UNCLEAR', `Could not get a Payrep token: ${(err as Error).message}`, 0, null);
    }
    const a = classifyRead<Obj | null>(r.status, r.body);
    if (!a.ok) throw new PayrepError(a.kind === 'REFUSED' || a.kind === 'TOKEN' ? 'CONFIG' : a.kind, `Payrep refused our keys: ${a.message}`, r.status, a.code);
    // The docs put the token in data; the sandbox (22 Oct 2026) puts it in message.data, with data null.
    const box = (a.data && typeof a.data === 'object' ? a.data : (((r.body as Obj | undefined)?.message as Obj | undefined)?.data as Obj | undefined)) ?? null;
    const value = str(box?.access_token);
    const ttl = Number(box?.expires_in) || 3600;
    if (!value) throw new PayrepError('UNCLEAR', 'Payrep answered without a token', r.status, '00');
    // Refresh 5 minutes early (never sooner than a minute from now).
    this.token = { value, refreshAt: Date.now() + Math.max(60, ttl - 300) * 1000 };
    return value;
  }
}
