import { Injectable } from '@nestjs/common';
import { FlutterwaveClient } from '../flutterwave/flutterwave.client';
import { FlutterwaveError } from '../flutterwave/flutterwave.errors';
import type { FlwTransfer } from '../flutterwave/flutterwave.types';
import { dec } from '../common/money';
import { NairaRail, RailRefusedError, RailTransfer, RailUnknownError } from './naira-rail';

/** Flutterwave filling the naira rail plug. */
@Injectable()
export class FlutterwaveRail implements NairaRail {
  readonly name = 'Flutterwave';

  constructor(private readonly client: FlutterwaveClient) {}

  async balance() {
    const b = await this.client.getBalance('NGN');
    return { available: dec(b.available_balance || '0'), ledger: dec(b.ledger_balance || '0') };
  }

  async banks() {
    try {
      return (await this.client.listBanks()).map(({ code, name }) => ({ code, name }));
    } catch (err) {
      throw this.lookupError(err);
    }
  }

  async resolveAccount(input: { bankCode: string; accountNumber: string }) {
    try {
      const r = await this.client.resolveAccount({ account_number: input.accountNumber, account_bank: input.bankCode });
      return { accountName: r.account_name };
    } catch (err) {
      throw this.lookupError(err);
    }
  }

  /** A look-up (not a send): Flutterwave's clear "no" is RailRefusedError; anything else is RailUnknownError. */
  private lookupError(err: unknown): Error {
    if (err instanceof FlutterwaveError && err.kind !== 'RATE_LIMITED' && err.kind !== 'CONFIG') return new RailRefusedError(err.message);
    return new RailUnknownError((err as Error).message);
  }

  async transfer(input: { reference: string; bankCode: string; accountNumber: string; amount: import('../common/money').Decimal; narration: string }): Promise<RailTransfer> {
    try {
      const t = await this.client.createTransfer({
        account_bank: input.bankCode,
        account_number: input.accountNumber,
        amount: Number(input.amount.toFixed(2)),
        narration: input.narration,
        currency: 'NGN',
        reference: input.reference,
        debit_currency: 'NGN',
      });
      return this.map(t);
    } catch (err) {
      // Only a definite answer from Flutterwave means nothing was sent.
      if (err instanceof FlutterwaveError && err.kind !== 'RATE_LIMITED') throw new RailRefusedError(err.message);
      if (err instanceof FlutterwaveError) throw new RailRefusedError('Flutterwave is busy; nothing was sent. Try again shortly.');
      throw new RailUnknownError((err as Error).message);
    }
  }

  async transferStatus(reference: string): Promise<RailTransfer | null> {
    const t = await this.client.getTransferByReference(reference);
    return t ? this.map(t) : null;
  }

  private map(t: FlwTransfer): RailTransfer {
    const s = String(t.status ?? '').toUpperCase();
    const status = s === 'SUCCESSFUL' ? 'SUCCESSFUL' : s === 'FAILED' ? 'FAILED' : 'PENDING';
    return {
      id: String(t.id),
      reference: t.reference,
      status,
      fee: t.fee === null || t.fee === undefined ? null : dec(String(t.fee)),
      reason: status === 'FAILED' ? (t.complete_message || 'The transfer failed') : null,
    };
  }
}
