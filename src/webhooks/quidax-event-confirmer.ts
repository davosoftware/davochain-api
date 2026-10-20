import { Injectable, Logger } from '@nestjs/common';
import { TxType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QuidaxClient } from '../quidax/quidax.client';
import { QuidaxError } from '../quidax/quidax.errors';
import { ProvisioningService } from '../users/provisioning.service';
import { SettlementService } from '../trades/settlement.service';
import type { QuidaxDeposit, QuidaxSwapTransaction, QuidaxWithdrawal } from '../quidax/quidax.types';

/**
 * OPEN_ISSUES A1: a Quidax message is a prompt, never the evidence.
 *
 * Every deposit, withdrawal or swap a message names is fetched from Quidax
 * itself, and only Quidax's own record decides what happens. The message's
 * signature already stops strangers; this stops anyone who has our webhook
 * secret from creating money with a fake "deposit" or refunding money that was
 * sent with a fake "rejected".
 *
 *  - Quidax has no such record → null: the message is dropped (logged).
 *  - Quidax cannot be reached → throws: the message is retried later, and
 *    nothing is credited or refunded on the message alone.
 *  - Quidax says it is still in progress → null: reconciliation asks again.
 */
@Injectable()
export class QuidaxEventConfirmer {
  private readonly log = new Logger(QuidaxEventConfirmer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly quidax: QuidaxClient,
    private readonly provisioning: ProvisioningService,
    private readonly settlement: SettlementService,
  ) {}

  /** The deposit as Quidax records it, or null. */
  async deposit(message: QuidaxDeposit): Promise<QuidaxDeposit | null> {
    if (!message?.id) return null;
    const userId = await this.provisioning.findUserByQuidax({
      quidaxUserId: message.user?.id ?? null,
      quidaxSn: message.user?.sn ?? null,
    });
    if (!userId) return null;
    const account = await this.prisma.quidaxAccount.findUnique({ where: { userId }, select: { quidaxUserId: true } });
    if (!account?.quidaxUserId) return null;

    let real: QuidaxDeposit;
    try {
      real = await this.quidax.fetchDeposit(account.quidaxUserId, message.id);
    } catch (err) {
      if (err instanceof QuidaxError && err.httpStatus === 404) {
        this.log.warn(`Deposit message ${message.id}: Quidax has no such deposit. Ignored (possible forgery).`);
        return null;
      }
      throw err;
    }
    if (!real || real.id !== message.id || real.currency?.toLowerCase() !== message.currency?.toLowerCase()) {
      this.log.warn(`Deposit message ${message.id}: Quidax's record does not match. Ignored.`);
      return null;
    }
    // Keep the owner Quidax reported in the message only if Quidax's own record lacks it.
    return real.user ? real : { ...real, user: message.user };
  }

  /** The withdrawal as Quidax records it, with the event it amounts to, or null. */
  async withdrawal(message: QuidaxWithdrawal): Promise<{ event: 'withdraw.successful' | 'withdraw.rejected'; data: QuidaxWithdrawal } | null> {
    if (!message?.reference) return null;
    const tx = await this.prisma.transaction.findFirst({ where: { reference: message.reference }, select: { type: true, userId: true } });
    if (!tx || tx.type !== TxType.WITHDRAWAL) return null;
    const owner = await this.settlement.quidaxIdFor(tx.userId);
    const real = await this.quidax.fetchWithdrawalByReference(message.reference, owner);
    if (!real) {
      this.log.warn(`Withdrawal message ${message.reference}: Quidax has no such withdrawal (yet). Left for reconciliation.`);
      return null;
    }
    const status = real.status?.toLowerCase();
    if (status === 'done') return { event: 'withdraw.successful', data: real };
    if (status === 'rejected' || status === 'failed') return { event: 'withdraw.rejected', data: real };
    return null;
  }

  /** The swap as Quidax records it, with the event it amounts to, or null. */
  async swap(message: QuidaxSwapTransaction): Promise<{ event: 'swap_transaction.complete' | 'swap_transaction.failed'; data: QuidaxSwapTransaction } | null> {
    if (!message?.id) return null;
    const leg = await this.prisma.settlementLeg.findFirst({
      where: { quidaxRef: message.id },
      select: { transaction: { select: { type: true, userId: true } } },
    });
    if (!leg) return null;
    // A customer's swap runs in their sub-account; the desk's own (a fallback buy) in the main account.
    const owner = leg.transaction.type === TxType.SWAP ? await this.settlement.quidaxIdFor(leg.transaction.userId) : 'me';
    const real = (await this.quidax.fetchSwapTransactions(owner)).find((s) => s.id === message.id);
    const status = real?.status?.toLowerCase();
    if (real && status === 'completed') return { event: 'swap_transaction.complete', data: real };
    if (real && status === 'failed') return { event: 'swap_transaction.failed', data: real };
    return null;
  }
}
