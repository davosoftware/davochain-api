import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { LedgerAccount, LedgerDirection, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Decimal, ZERO, dec, type Numeric } from '../common/money';

export interface LedgerLeg {
  account: LedgerAccount;
  userId?: string | null;
  assetCode: string;
  direction: LedgerDirection;
  amount: Numeric;
  memo?: string;
}

export class InsufficientBalanceError extends BadRequestException {
  constructor(assetCode: string, needed: Decimal, available: Decimal) {
    super(
      `Insufficient ${assetCode.toUpperCase()} balance: need ${needed.toFixed()}, have ${available.toFixed()}`,
    );
  }
}

/**
 * The only thing that writes to `balances`.
 *
 * Rules, all of them load-bearing:
 *
 *  1. Every mutation runs inside a transaction with SELECT … FOR UPDATE on the
 *     balance row. Without it a user spends the same balance twice by tapping fast.
 *  2. LedgerEntry is append-only. Corrections are compensating entries.
 *  3. Legs must balance: total debits == total credits, per asset.
 *  4. Lock BEFORE any network call. Funds move available -> locked in the same
 *     transaction that creates the pending record.
 */
@Injectable()
export class LedgerService {
  private readonly log = new Logger(LedgerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Double-entry post. Throws unless debits and credits balance per asset. */
  async post(
    tx: Prisma.TransactionClient,
    legs: LedgerLeg[],
    transactionId?: string,
  ): Promise<void> {
    this.assertBalanced(legs);

    for (const leg of legs) {
      if (leg.account === LedgerAccount.USER) {
        if (!leg.userId) throw new Error('USER ledger leg requires a userId');
        const delta =
          leg.direction === LedgerDirection.CREDIT ? dec(leg.amount) : dec(leg.amount).neg();
        await this.adjustAvailable(tx, leg.userId, leg.assetCode, delta);
      }
    }

    await tx.ledgerEntry.createMany({
      data: legs.map((leg) => ({
        transactionId: transactionId ?? null,
        account: leg.account,
        userId: leg.userId ?? null,
        assetCode: leg.assetCode,
        direction: leg.direction,
        amount: dec(leg.amount).toFixed(),
        memo: leg.memo ?? null,
      })),
    });
  }

  private assertBalanced(legs: LedgerLeg[]): void {
    const byAsset = new Map<string, Decimal>();
    for (const leg of legs) {
      const signed =
        leg.direction === LedgerDirection.DEBIT ? dec(leg.amount) : dec(leg.amount).neg();
      byAsset.set(leg.assetCode, (byAsset.get(leg.assetCode) ?? ZERO).plus(signed));
    }
    for (const [asset, net] of byAsset) {
      if (!net.isZero()) {
        throw new Error(
          `Unbalanced ledger post for ${asset}: debits minus credits = ${net.toFixed()}`,
        );
      }
    }
  }

  /**
   * Move funds available -> locked. Call this before any outbound request,
   * inside the same transaction that writes the pending row.
   */
  async lock(
    tx: Prisma.TransactionClient,
    userId: string,
    assetCode: string,
    amount: Numeric,
  ): Promise<void> {
    const amt = dec(amount);
    if (amt.lte(0)) throw new Error('lock amount must be positive');

    const balance = await this.lockRow(tx, userId, assetCode);
    const available = dec(balance.available);
    if (available.lt(amt)) throw new InsufficientBalanceError(assetCode, amt, available);

    await tx.balance.update({
      where: { userId_assetCode: { userId, assetCode } },
      data: {
        available: available.minus(amt).toFixed(),
        locked: dec(balance.locked).plus(amt).toFixed(),
      },
    });
  }

  /** Release a lock back to available — a trade that failed cleanly. */
  async unlock(
    tx: Prisma.TransactionClient,
    userId: string,
    assetCode: string,
    amount: Numeric,
  ): Promise<void> {
    const amt = dec(amount);
    const balance = await this.lockRow(tx, userId, assetCode);
    const locked = dec(balance.locked);
    if (locked.lt(amt)) {
      throw new Error(
        `Cannot unlock ${amt.toFixed()} ${assetCode}: only ${locked.toFixed()} locked`,
      );
    }
    await tx.balance.update({
      where: { userId_assetCode: { userId, assetCode } },
      data: {
        available: dec(balance.available).plus(amt).toFixed(),
        locked: locked.minus(amt).toFixed(),
      },
    });
  }

  /**
   * Consume a lock — the trade settled. The locked amount leaves the user for
   * good, balanced against whichever account received it.
   */
  async settleLocked(
    tx: Prisma.TransactionClient,
    params: {
      userId: string;
      assetCode: string;
      amount: Numeric;
      counterparty: LedgerAccount;
      transactionId: string;
      memo?: string;
    },
  ): Promise<void> {
    const amt = dec(params.amount);
    const balance = await this.lockRow(tx, params.userId, params.assetCode);
    const locked = dec(balance.locked);
    if (locked.lt(amt)) {
      throw new Error(
        `Cannot settle ${amt.toFixed()} ${params.assetCode}: only ${locked.toFixed()} locked`,
      );
    }

    await tx.balance.update({
      where: { userId_assetCode: { userId: params.userId, assetCode: params.assetCode } },
      data: { locked: locked.minus(amt).toFixed() },
    });

    await tx.ledgerEntry.createMany({
      data: [
        {
          transactionId: params.transactionId,
          account: LedgerAccount.USER,
          userId: params.userId,
          assetCode: params.assetCode,
          direction: LedgerDirection.DEBIT,
          amount: amt.toFixed(),
          memo: params.memo ?? null,
        },
        {
          transactionId: params.transactionId,
          account: params.counterparty,
          userId: null,
          assetCode: params.assetCode,
          direction: LedgerDirection.CREDIT,
          amount: amt.toFixed(),
          memo: params.memo ?? null,
        },
      ],
    });
  }

  /** Credit a user from a non-user account. */
  async credit(
    tx: Prisma.TransactionClient,
    params: {
      userId: string;
      assetCode: string;
      amount: Numeric;
      counterparty: LedgerAccount;
      transactionId?: string;
      memo?: string;
    },
  ): Promise<void> {
    await this.post(
      tx,
      [
        {
          account: params.counterparty,
          assetCode: params.assetCode,
          direction: LedgerDirection.DEBIT,
          amount: params.amount,
          memo: params.memo,
        },
        {
          account: LedgerAccount.USER,
          userId: params.userId,
          assetCode: params.assetCode,
          direction: LedgerDirection.CREDIT,
          amount: params.amount,
          memo: params.memo,
        },
      ],
      params.transactionId,
    );
  }

  async getBalance(
    userId: string,
    assetCode: string,
  ): Promise<{ available: Decimal; locked: Decimal }> {
    const row = await this.prisma.balance.findUnique({
      where: { userId_assetCode: { userId, assetCode } },
    });
    return {
      available: row ? dec(row.available) : ZERO,
      locked: row ? dec(row.locked) : ZERO,
    };
  }

  /**
   * SELECT … FOR UPDATE, creating the row if absent.
   * The screen-side balance check is UX; this one is real.
   */
  private async lockRow(
    tx: Prisma.TransactionClient,
    userId: string,
    assetCode: string,
  ): Promise<{ available: string; locked: string }> {
    await tx.balance.upsert({
      where: { userId_assetCode: { userId, assetCode } },
      create: { userId, assetCode, available: '0', locked: '0' },
      update: {},
    });

    const rows = await tx.$queryRaw<Array<{ available: string; locked: string }>>`
      SELECT available::text, locked::text
      FROM balances
      WHERE "userId" = ${userId} AND "assetCode" = ${assetCode}
      FOR UPDATE
    `;
    if (rows.length === 0) throw new Error(`Balance row vanished for ${userId}/${assetCode}`);
    return rows[0];
  }

  private async adjustAvailable(
    tx: Prisma.TransactionClient,
    userId: string,
    assetCode: string,
    delta: Decimal,
  ): Promise<void> {
    const balance = await this.lockRow(tx, userId, assetCode);
    const next = dec(balance.available).plus(delta);
    if (next.lt(0)) {
      throw new InsufficientBalanceError(assetCode, delta.abs(), dec(balance.available));
    }
    await tx.balance.update({
      where: { userId_assetCode: { userId, assetCode } },
      data: { available: next.toFixed() },
    });
  }

  /**
   * The invariant from §4 of the design guide, per asset:
   *
   *   Σ(user ledger) + Σ(fee receivable) == sub-account balances + main wallet
   *
   * Any drift is either an unswept fee, an in-flight settlement, or a bug —
   * and you want to know which within minutes, not at month end.
   */
  async projectedTotals(assetCode: string): Promise<{
    userTotal: Decimal;
    lockedTotal: Decimal;
    receivableTotal: Decimal;
  }> {
    const [balances, receivables] = await Promise.all([
      this.prisma.balance.aggregate({
        where: { assetCode },
        _sum: { available: true, locked: true },
      }),
      this.prisma.feeReceivable.aggregate({
        where: { assetCode, sweptAt: null },
        _sum: { amount: true },
      }),
    ]);

    return {
      userTotal: dec(balances._sum.available ?? 0),
      lockedTotal: dec(balances._sum.locked ?? 0),
      receivableTotal: dec(receivables._sum.amount ?? 0),
    };
  }

  /** Rebuild a balance from entries. The audit answer to "is this number right?". */
  async replayBalance(userId: string, assetCode: string): Promise<Decimal> {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { userId, assetCode, account: LedgerAccount.USER },
      select: { direction: true, amount: true },
    });
    return entries.reduce(
      (sum, e) =>
        e.direction === LedgerDirection.CREDIT ? sum.plus(dec(e.amount)) : sum.minus(dec(e.amount)),
      ZERO,
    );
  }
}
