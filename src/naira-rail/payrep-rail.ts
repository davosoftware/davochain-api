import { Injectable } from '@nestjs/common';
import { AlertType } from '@prisma/client';
import { dec, type Decimal } from '../common/money';
import { OpsAlertsService } from '../common/ops-alerts/ops-alerts.service';
import { PayrepApi } from '../payrep/payrep.api';
import { PayrepConfig } from '../payrep/payrep.config';
import { PayrepError } from '../payrep/payrep.errors';
import type { PayrepNameEnquiry } from '../payrep/payrep.types';
import { NairaRail, RailRefusedError, RailTransfer, RailUnknownError } from './naira-rail';

const HOUR = 3_600_000;
const INTRA_BANK = '090823';

/**
 * Payrep MFB filling the naira rail plug (spec §5). A transfer is name-checked,
 * sent once, and only ever finished through Transaction Status. A refund follows
 * a clear "no" only: the user's rule is that an unclear result stays pending.
 */
@Injectable()
export class PayrepRail implements NairaRail {
  readonly name = 'Payrep';
  private mainName: { value: string; at: number } | null = null;

  constructor(
    private readonly payrep: PayrepApi,
    private readonly cfg: PayrepConfig,
    private readonly alerts: OpsAlertsService,
  ) {}

  private main(): string {
    const m = this.cfg.mainAccount;
    if (!m) throw new RailRefusedError('PAYREP_MAIN_ACCOUNT is not set: nothing was sent');
    return m;
  }

  async balance() {
    try {
      const a = await this.payrep.account(this.main());
      return { available: dec(a.balance || '0'), ledger: dec(a.balance || '0') };
    } catch (err) {
      throw this.lookupError(err);
    }
  }

  async banks() {
    try {
      return (await this.payrep.banks()).map(({ code, name }) => ({ code, name }));
    } catch (err) {
      throw this.lookupError(err);
    }
  }

  async resolveAccount(input: { bankCode: string; accountNumber: string }) {
    try {
      return { accountName: (await this.payrep.nameEnquiry(input)).accountName };
    } catch (err) {
      throw this.lookupError(err);
    }
  }

  async transfer(input: { reference: string; bankCode: string; accountNumber: string; amount: Decimal; narration: string }): Promise<RailTransfer> {
    const source = this.main();
    // 1. Name enquiry and our own account name: nothing is sent yet, so any failure here is safe to refund.
    let ne: PayrepNameEnquiry;
    let sourceName: string;
    try {
      [ne, sourceName] = await Promise.all([this.payrep.nameEnquiry({ accountNumber: input.accountNumber, bankCode: input.bankCode }), this.sourceName(source)]);
    } catch (err) {
      throw new RailRefusedError(`Payrep could not check the account, so nothing was sent: ${(err as Error).message}`);
    }
    // 2. Send once.
    const a = await this.payrep.transfer({
      reference: input.reference,
      sourceAccountNumber: source,
      sourceAccountName: sourceName,
      beneficiaryAccountNumber: ne.accountNumber,
      beneficiaryAccountName: ne.accountName,
      bankCode: ne.bankCode,
      bankName: ne.bankName,
      amount: input.amount.toFixed(2),
      transferType: ne.bankCode === INTRA_BANK ? 'intra' : ne.transferType,
      remarks: input.narration.slice(0, 100),
      sessionId: ne.sessionId,
    });
    if (a.kind === 'SENT') return { id: a.id, reference: input.reference, status: 'PENDING', fee: a.fee ? dec(a.fee) : null, reason: null };
    if (a.kind === 'REFUSED') throw new RailRefusedError(a.reason);
    if (a.kind === 'QUEUED_FOR_APPROVAL') {
      await this.alerts.raise(
        AlertType.NAIRA_RAIL_CONFIG,
        'maker-checker',
        'Payrep queued a transfer for approval instead of sending it',
        [
          `Reference: ${input.reference}`,
          'Turn maker-checker OFF for the role our API key uses (Payrep portal → Settings → Roles & Permissions → Initiate Transfer).',
          'Approve or reject this one in the Payrep portal; DavoChain keeps it pending and checks its status.',
        ],
        HOUR,
      );
      throw new RailUnknownError('Payrep queued the transfer for approval; it has not been sent');
    }
    throw new RailUnknownError(a.reason);
  }

  async transferStatus(reference: string): Promise<RailTransfer | null> {
    const s = await this.payrep.transactionStatus(reference);
    if (s.kind === 'NOT_FOUND') return null;
    if (s.kind === 'UNCLEAR') throw new RailUnknownError(s.reason);
    return { id: reference, reference, status: s.status, fee: null, reason: s.status === 'FAILED' ? 'Payrep reports the transfer failed' : null };
  }

  /** The exact name on our main account, which funds_transfer requires. Cached for an hour. */
  private async sourceName(account: string): Promise<string> {
    if (this.mainName && Date.now() - this.mainName.at < HOUR) return this.mainName.value;
    const a = await this.payrep.account(account);
    if (!a.accountName) throw new PayrepError('UNCLEAR', 'Payrep did not return our account name', 200, '00');
    this.mainName = { value: a.accountName, at: Date.now() };
    return a.accountName;
  }

  /** A look-up (not a send): Payrep's clear "no" is RailRefusedError; anything else is RailUnknownError. */
  private lookupError(err: unknown): Error {
    if (err instanceof RailRefusedError) return err;
    if (err instanceof PayrepError && err.kind === 'REFUSED') return new RailRefusedError(err.message);
    return new RailUnknownError((err as Error).message);
  }
}
