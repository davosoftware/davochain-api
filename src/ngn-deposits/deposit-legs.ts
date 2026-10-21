import { LedgerAccount, LedgerDirection } from '@prisma/client';
import type { Decimal } from '../common/money';
import type { LedgerLeg } from '../ledger/ledger.service';

export class DepositLegsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DepositLegsError';
  }
}

/** True when the three figures can be posted: amount = settled + fee, all present. */
export function depositBalances(amount: Decimal | null, settled: Decimal | null, fee: Decimal | null): boolean {
  return Boolean(amount && settled && fee) && amount!.gt(0) && settled!.gte(0) && fee!.gte(0) && amount!.eq(settled!.plus(fee!));
}

/**
 * The ledger entries for a naira deposit whose fee DavoChain absorbs (A3):
 *
 *   USER          CREDIT  amount   what the customer sent; all of it is theirs
 *   EXTERNAL      DEBIT   settled  what reaches DavoChain's Payrep main account
 *   PROVIDER_FEE  DEBIT   fee      what Payrep kept: a cost, not revenue
 *
 * They balance only when amount = settled + fee; anything else is refused, so a
 * fee surprise can never post a lopsided deposit. Zero legs are left out.
 */
export function depositLegs(p: { userId: string; amount: Decimal; settled: Decimal; fee: Decimal; memo: string }): LedgerLeg[] {
  if (!p.amount.gt(0)) throw new DepositLegsError('A deposit must be for more than zero');
  if (p.settled.lt(0) || p.fee.lt(0)) throw new DepositLegsError('The settled amount and the fee cannot be negative');
  if (!p.amount.eq(p.settled.plus(p.fee))) {
    throw new DepositLegsError(
      `Deposit does not balance: ${p.amount.toFixed()} ≠ ${p.settled.toFixed()} + ${p.fee.toFixed()}`,
    );
  }
  const legs: LedgerLeg[] = [
    { account: LedgerAccount.USER, userId: p.userId, assetCode: 'ngn', direction: LedgerDirection.CREDIT, amount: p.amount.toFixed(), memo: p.memo },
  ];
  if (p.settled.gt(0)) {
    legs.push({ account: LedgerAccount.EXTERNAL, assetCode: 'ngn', direction: LedgerDirection.DEBIT, amount: p.settled.toFixed(), memo: p.memo });
  }
  if (p.fee.gt(0)) {
    legs.push({ account: LedgerAccount.PROVIDER_FEE, assetCode: 'ngn', direction: LedgerDirection.DEBIT, amount: p.fee.toFixed(), memo: p.memo });
  }
  return legs;
}
