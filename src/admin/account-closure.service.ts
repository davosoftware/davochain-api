import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, TxStatus, UserStatus, VirtualAccountStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from '../auth/password.service';
import { MailService } from '../common/mail.service';
import { TemplatedMailService } from '../cms/templated-mail.service';
import { VirtualAccountsService } from '../ngn-deposits/virtual-accounts.service';
import { dec } from '../common/money';

export type ClosureBlocker =
  | { code: 'ALREADY_CLOSED'; message: string }
  | { code: 'BALANCE'; asset: string; amount: string; message: string }
  | { code: 'TRANSACTIONS'; count: number; message: string }
  | { code: 'GIFT_CARDS'; count: number; message: string };

/** Money is still moving in these; closing now could strand it. */
const IN_FLIGHT: TxStatus[] = [TxStatus.PENDING, TxStatus.PROCESSING, TxStatus.ON_HOLD, TxStatus.RECONCILING];

const WRONG_PASSWORD = 'That password is not correct.';

/** The placeholder that frees the real email address for a new sign-up. Not deliverable. */
const releasedEmail = (userId: string) => `closed-${userId}@closed.davochain`;

/**
 * People → Users → Close account (decisions 28 Oct 2026).
 *
 * "Delete" closes rather than erases: the money records must still add up to
 * what Quidax holds, and identity and transaction records are kept for the
 * legal period. A closed account can never sign in again; its email and phone
 * are released so the person can register afresh (and verify again). Owners
 * only, with their password and a reason. Refused while the customer holds any
 * money or has anything in progress, so we never close an account we owe.
 */
@Injectable()
export class AccountClosureService {
  private readonly log = new Logger(AccountClosureService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly mail: MailService,
    private readonly templated: TemplatedMailService,
    private readonly virtualAccounts: VirtualAccountsService,
  ) {}

  /** What stops this account being closed right now; empty when it can be. */
  async check(userId: string): Promise<{ canClose: boolean; blockers: ClosureBlocker[] }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    const blockers = await this.blockers(this.prisma, userId, user.status);
    return { canClose: blockers.length === 0, blockers };
  }

  async close(
    actor: { id: string; role: string; ip?: string },
    userId: string,
    input: { password: string; reason: string },
  ): Promise<{ closed: true; closedAt: string }> {
    if (actor.role !== 'OWNER') throw new ForbiddenException('Only an owner can close a customer account.');
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < 10) throw new BadRequestException('Say why, in at least 10 characters. It goes in the audit log.');
    const admin = await this.prisma.adminUser.findUnique({ where: { id: actor.id }, select: { passwordHash: true } });
    if (!admin || typeof input.password !== 'string' || !(await this.passwords.verify(input.password, admin.passwordHash))) {
      throw new BadRequestException(WRONG_PASSWORD);
    }

    const closedAt = new Date();
    const before = await this.prisma.$transaction(async (tx) => {
      const found = await tx.user.findUnique({ where: { id: userId } });
      if (!found) throw new NotFoundException('User not found');
      // A copy taken before the update: the customer is emailed at their real address.
      const user = { status: found.status, email: found.email, phone: found.phone, firstName: found.firstName, lastName: found.lastName };
      // Checked again inside the transaction, so nothing can slip in between.
      const blockers = await this.blockers(tx, userId, user.status);
      if (blockers.length) {
        throw new ConflictException({
          statusCode: 409,
          code: 'ACCOUNT_NOT_EMPTY',
          message: 'This account cannot be closed yet: ' + blockers.map((b) => b.message).join('; ') + '.',
          blockers,
        });
      }
      await tx.user.update({
        where: { id: userId },
        data: {
          status: UserStatus.CLOSED,
          closedAt,
          closedReason: reason,
          closedBy: actor.id,
          closedEmail: user.email,
          closedPhone: user.phone,
          email: releasedEmail(userId),
          phone: null,
        },
      });
      await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: closedAt } });
      await tx.adminAuditLog.create({
        data: {
          adminUserId: actor.id,
          action: 'user.close',
          entity: 'User',
          entityId: userId,
          before: { status: user.status, email: user.email, phone: user.phone } as Prisma.InputJsonValue,
          after: { status: UserStatus.CLOSED, email: releasedEmail(userId), phone: null, reason } as Prisma.InputJsonValue,
          ip: actor.ip ?? null,
        },
      });
      return user;
    });

    // After the commit: none of these may undo the closing.
    await this.virtualAccounts
      .setDesiredForUser(userId, VirtualAccountStatus.INACTIVE, { background: true })
      .catch(() => undefined);
    await this.templated
      .send({
        key: 'user.closed',
        to: before.email,
        variables: { firstName: before.firstName, lastName: before.lastName, email: before.email },
      })
      .catch((e: Error) => this.log.warn(`Closing email to ${userId} failed: ${e.message}`));
    await this.emailOwners(`${before.firstName} ${before.lastName} (${before.email})`, reason);

    return { closed: true, closedAt: closedAt.toISOString() };
  }

  private async blockers(db: Pick<PrismaService, 'balance' | 'transaction' | 'giftCardTrade'>, userId: string, status: UserStatus | string): Promise<ClosureBlocker[]> {
    if (status === UserStatus.CLOSED) return [{ code: 'ALREADY_CLOSED', message: 'This account is already closed' }];
    const [balances, inFlight, giftCards] = await Promise.all([
      db.balance.findMany({ where: { userId } }),
      db.transaction.count({ where: { userId, status: { in: IN_FLIGHT } } }),
      db.giftCardTrade.count({ where: { userId, status: 'PENDING' } }),
    ]);
    const out: ClosureBlocker[] = [];
    for (const b of balances) {
      const total = dec(b.available).plus(dec(b.locked));
      if (total.gt(0)) {
        const amount = total.toFixed();
        out.push({ code: 'BALANCE', asset: b.assetCode, amount, message: `Holds ${amount} ${b.assetCode.toUpperCase()}` });
      }
    }
    if (inFlight) {
      out.push({ code: 'TRANSACTIONS', count: inFlight, message: `${inFlight} transaction${inFlight === 1 ? '' : 's'} still in progress` });
    }
    if (giftCards) {
      out.push({ code: 'GIFT_CARDS', count: giftCards, message: `${giftCards} gift card sale${giftCards === 1 ? '' : 's'} waiting for a decision` });
    }
    return out;
  }

  /** Every owner hears about a closed account. Never fails the closing. */
  private async emailOwners(who: string, reason: string): Promise<void> {
    try {
      const owners = await this.prisma.adminUser.findMany({ where: { role: 'OWNER', isActive: true }, select: { email: true } });
      const text = [
        `A customer account was closed: ${who}.`,
        `Reason: ${reason}`,
        '',
        'If this was not expected, sign in to the dashboard and check the audit log.',
      ].join('\n');
      const html = `<p>${text.split('\n').map(escapeHtml).join('<br>')}</p>`;
      for (const o of owners) {
        await this.mail.send({ to: o.email, subject: '[DavoChain] A customer account was closed', text, html, templateKey: 'account-closed' }).catch(() => false);
      }
    } catch (err) {
      this.log.error(`Could not email owners about a closed account: ${(err as Error).message}`);
    }
  }
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
