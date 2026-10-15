import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AdminRole, LedgerAccount, LedgerDirection, TxStatus, TxType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { dec } from '../common/money';

export interface CorrectionInput {
  userId: string;
  asset: string;
  direction: 'CREDIT' | 'DEBIT';
  amount: string;
  reason: string;
}

/**
 * An owner puts a customer's record right so it matches what Quidax really
 * holds (the reconciliation screen). Our records only: no coins move. The other
 * side of every line is the ADJUSTMENT account, so a correction never reads as
 * revenue. Owner only, one person, with a written reason (decision 15 Oct).
 */
@Injectable()
export class BalanceCorrectionsService {
  private readonly log = new Logger(BalanceCorrectionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  async correct(actor: { id: string; role: AdminRole }, input: CorrectionInput): Promise<{ transactionId: string; before: string; after: string }> {
    if (actor.role !== AdminRole.OWNER) throw new ForbiddenException('Only an owner can correct a balance');
    const reason = (input.reason ?? '').trim();
    if (reason.length < 10) throw new BadRequestException('Write a reason (at least 10 characters)');
    if (!/^\d+(\.\d+)?$/.test(String(input.amount ?? '').trim()) || dec(input.amount).lte(0)) {
      throw new BadRequestException('Enter an amount greater than zero');
    }
    const code = input.asset.toLowerCase();
    const asset = await this.prisma.asset.findFirst({ where: { code, isListed: true, isFiat: false }, select: { code: true, displayScale: true } });
    if (!asset) throw new BadRequestException('Choose a listed coin');
    const user = await this.prisma.user.findUnique({ where: { id: input.userId }, select: { id: true } });
    if (!user) throw new NotFoundException('User not found');

    const amount = dec(input.amount);
    const before = (await this.ledger.getBalance(input.userId, code)).available;
    if (input.direction === 'DEBIT' && amount.gt(before)) {
      throw new BadRequestException(`The customer only has ${before.toFixed(asset.displayScale)} ${code.toUpperCase()} available`);
    }

    const credit = input.direction === 'CREDIT';
    const tx = await this.prisma.serializable(async (t) => {
      const created = await t.transaction.create({
        data: {
          userId: input.userId,
          type: TxType.ADJUSTMENT,
          status: TxStatus.COMPLETED,
          ...(credit ? { toAsset: code, toAmount: amount.toFixed() } : { fromAsset: code, fromAmount: amount.toFixed() }),
          reference: `adj_${randomUUID()}`,
          adjustedBy: actor.id,
          adjustmentReason: reason,
          completedAt: new Date(),
        },
      });
      const memo = `Balance correction by an owner`;
      const userLeg = { account: LedgerAccount.USER, userId: input.userId, assetCode: code, amount: amount.toFixed(), memo };
      const adjLeg = { account: LedgerAccount.ADJUSTMENT, assetCode: code, amount: amount.toFixed(), memo };
      // A debit of the USER line goes through the ledger's own balance guard, so
      // it can never take locked money or go below zero even in a race.
      await this.ledger.post(
        t,
        credit
          ? [{ ...adjLeg, direction: LedgerDirection.DEBIT }, { ...userLeg, direction: LedgerDirection.CREDIT }]
          : [{ ...userLeg, direction: LedgerDirection.DEBIT }, { ...adjLeg, direction: LedgerDirection.CREDIT }],
        created.id,
      );
      return created;
    });

    const after = (await this.ledger.getBalance(input.userId, code)).available;
    this.log.warn(`Balance correction ${tx.id}: ${input.direction} ${amount.toFixed()} ${code} for ${input.userId} by owner ${actor.id}`);
    return { transactionId: tx.id, before: before.toFixed(), after: after.toFixed() };
  }

  /** The latest corrections, newest first, for the reconciliation screen. */
  async recent(limit = 50) {
    const rows = await this.prisma.transaction.findMany({
      where: { type: TxType.ADJUSTMENT },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
      include: { user: { select: { firstName: true, lastName: true, email: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      userId: r.userId,
      name: r.user ? `${r.user.firstName} ${r.user.lastName}` : '',
      email: r.user?.email ?? '',
      direction: r.toAsset ? 'CREDIT' : 'DEBIT',
      asset: r.toAsset ?? r.fromAsset,
      amount: dec((r.toAmount ?? r.fromAmount)!).toFixed(),
      reason: r.adjustmentReason,
      adjustedBy: r.adjustedBy,
    }));
  }
}
