import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma, SavedBankAccount, SavedCryptoAddress } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from '../auth/password.service';
import { recordFailedLogin } from '../auth/failed-logins';
import { NotificationsService } from '../notifications/notifications.service';
import { levelOf } from '../levels/levels';
import { WithdrawalsService } from './withdrawals.service';
import { assertCryptoDestination } from './destination-rules';

const HOUR = 3_600_000;

export interface BankView {
  id: string;
  bankCode: string;
  bankName: string;
  /** The full number is never sent back after saving. */
  accountNumberMasked: string;
  accountName: string;
  nickname: string | null;
  usableFrom: string;
  usableNow: boolean;
}

export interface CryptoView {
  id: string;
  assetCode: string;
  networkId: string;
  networkLabel: string;
  address: string;
  destinationTag: string | null;
  nickname: string | null;
  usableFrom: string;
  usableNow: boolean;
}

export type DestinationKind = 'bank' | 'crypto';

/** "******1234": enough to recognise, not enough to reuse. */
export function maskAccount(n: string): string {
  return '*'.repeat(Math.max(n.length - 4, 0)) + n.slice(-4);
}

export function bankView(r: SavedBankAccount, now = new Date()): BankView {
  return {
    id: r.id,
    bankCode: r.bankCode,
    bankName: r.bankName,
    accountNumberMasked: maskAccount(r.accountNumber),
    accountName: r.accountName,
    nickname: r.nickname ?? null,
    usableFrom: r.usableFrom.toISOString(),
    usableNow: r.usableFrom <= now,
  };
}

export function cryptoView(r: SavedCryptoAddress, networkLabel: string, now = new Date()): CryptoView {
  return {
    id: r.id,
    assetCode: r.assetCode,
    networkId: r.networkId,
    networkLabel,
    address: r.address,
    destinationTag: r.destinationTag ?? null,
    nickname: r.nickname ?? null,
    usableFrom: r.usableFrom.toISOString(),
    usableNow: r.usableFrom <= now,
  };
}

/**
 * Where a customer's withdrawals may go (Part 2, C6). Withdrawals go only to
 * these. Adding one needs the password again (so a stolen session alone cannot
 * add a thief's account), is capped by an admin setting, waits out the level's
 * "after new address/bank" cool-off, and is announced by email.
 */
@Injectable()
export class SavedDestinationsService {
  private readonly log = new Logger(SavedDestinationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly withdrawals: WithdrawalsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Password again, counted like a sign-in attempt. Returns the user's tier for the cool-off. */
  private async confirmPassword(userId: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true, kycTier: true, lockedUntil: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new ForbiddenException(`Too many failed attempts. Try again after ${user.lockedUntil.toISOString()}`);
    }
    if (!(await this.passwords.verify(password, user.passwordHash))) {
      await recordFailedLogin(this.prisma, 'users', userId);
      throw new UnauthorizedException('Incorrect password');
    }
    return user;
  }

  private async usableFrom(t: Prisma.TransactionClient, kycTier: Parameters<typeof levelOf>[0]): Promise<Date> {
    const c = await t.levelCooloff.findUnique({ where: { level: levelOf(kycTier) } });
    return new Date(Date.now() + (c?.afterNewPayeeHours ?? 0) * HOUR);
  }

  /** The unique index on live rows answers a race the count could not see. */
  private async saving<T>(duplicate: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new BadRequestException(duplicate);
      throw err;
    }
  }

  private announce(userId: string, destination: string): void {
    this.notifications
      .notify({
        userId,
        type: 'security.destination_added',
        title: 'New withdrawal destination added',
        body: `${destination} was added to your account. If this wasn't you, contact support now.`,
        email: { key: 'destination.added', variables: { destination } },
      })
      .catch((err: Error) => this.log.error(`Could not announce a new destination for ${userId}: ${err.message}`));
  }

  async addBank(userId: string, input: { bankCode: string; accountNumber: string; nickname?: string; password: string }): Promise<BankView> {
    const user = await this.confirmPassword(userId, input.password);
    // The name comes from the bank, never from the app (no name-match rule: decision 15 Oct).
    const { bankName, accountName } = await this.withdrawals.lookupNgnBankAccount({ bankCode: input.bankCode, accountNumber: input.accountNumber });
    const duplicate = 'This account is already saved.';
    const saved = await this.saving(duplicate, () =>
      this.prisma.serializable(async (t) => {
        const limits = await t.platformLimit.findUnique({ where: { id: 'default' } });
        const max = limits?.maxSavedBankAccounts ?? 5;
        const live = await t.savedBankAccount.count({ where: { userId, removedAt: null } });
        if (live >= max) throw new BadRequestException(`You can save up to ${max} bank accounts. Remove one to add another.`);
        const dup = await t.savedBankAccount.findFirst({
          where: { userId, bankCode: input.bankCode, accountNumber: input.accountNumber, removedAt: null },
        });
        if (dup) throw new BadRequestException(duplicate);
        return t.savedBankAccount.create({
          data: {
            userId,
            bankCode: input.bankCode,
            bankName,
            accountNumber: input.accountNumber,
            accountName,
            nickname: input.nickname?.trim() || null,
            usableFrom: await this.usableFrom(t, user.kycTier),
          },
        });
      }),
    );
    this.announce(userId, `${bankName} ••••${input.accountNumber.slice(-4)}`);
    return bankView(saved);
  }

  async addCrypto(
    userId: string,
    input: { asset: string; network: string; address: string; destinationTag?: string; nickname?: string; password: string },
  ): Promise<CryptoView> {
    const user = await this.confirmPassword(userId, input.password);
    const address = input.address.trim();
    const tag = input.destinationTag?.trim() || null;
    const { code, network } = await assertCryptoDestination(this.prisma, { ...input, address, destinationTag: tag });
    const duplicate = 'This address is already saved.';
    const saved = await this.saving(duplicate, () =>
      this.prisma.serializable(async (t) => {
        const limits = await t.platformLimit.findUnique({ where: { id: 'default' } });
        const max = limits?.maxSavedCryptoAddresses ?? 10;
        const live = await t.savedCryptoAddress.count({ where: { userId, removedAt: null } });
        if (live >= max) throw new BadRequestException(`You can save up to ${max} crypto addresses. Remove one to add another.`);
        const dup = await t.savedCryptoAddress.findFirst({
          where: { userId, assetCode: code, networkId: input.network, address, destinationTag: tag, removedAt: null },
        });
        if (dup) throw new BadRequestException(duplicate);
        return t.savedCryptoAddress.create({
          data: {
            userId,
            assetCode: code,
            networkId: input.network,
            address,
            destinationTag: tag,
            nickname: input.nickname?.trim() || null,
            usableFrom: await this.usableFrom(t, user.kycTier),
          },
        });
      }),
    );
    this.announce(userId, `${code.toUpperCase()} on ${network.label} (${address.slice(0, 6)}…${address.slice(-4)})`);
    return cryptoView(saved, network.label);
  }

  async listBanks(userId: string): Promise<{ max: number; items: BankView[] }> {
    const [limits, rows] = await Promise.all([
      this.prisma.platformLimit.findUnique({ where: { id: 'default' } }),
      this.prisma.savedBankAccount.findMany({ where: { userId, removedAt: null }, orderBy: { createdAt: 'desc' } }),
    ]);
    const now = new Date();
    return { max: limits?.maxSavedBankAccounts ?? 5, items: rows.map((r) => bankView(r, now)) };
  }

  async listCrypto(userId: string): Promise<{ max: number; items: CryptoView[] }> {
    const [limits, rows] = await Promise.all([
      this.prisma.platformLimit.findUnique({ where: { id: 'default' } }),
      this.prisma.savedCryptoAddress.findMany({ where: { userId, removedAt: null }, orderBy: { createdAt: 'desc' } }),
    ]);
    return { max: limits?.maxSavedCryptoAddresses ?? 10, items: await this.withLabels(rows) };
  }

  /** Network labels for a set of saved addresses, in one read. */
  async withLabels(rows: SavedCryptoAddress[]): Promise<CryptoView[]> {
    if (rows.length === 0) return [];
    const networks = await this.prisma.assetNetwork.findMany({
      where: { OR: rows.map((r) => ({ assetCode: r.assetCode, networkId: r.networkId })) },
      select: { assetCode: true, networkId: true, label: true },
    });
    const now = new Date();
    const label = (r: SavedCryptoAddress) => networks.find((n) => n.assetCode === r.assetCode && n.networkId === r.networkId)?.label ?? r.networkId;
    return rows.map((r) => cryptoView(r, label(r), now));
  }

  /**
   * Soft delete: past withdrawals still point at the row. `by` is 'user' or an
   * admin's id. Returns the row before and after, for the admin audit.
   */
  async remove(kind: DestinationKind, userId: string, id: string, by: string) {
    const removedAt = new Date();
    if (kind === 'bank') {
      const row = await this.prisma.savedBankAccount.findFirst({ where: { id, userId, removedAt: null } });
      if (!row) throw new NotFoundException('Saved account not found');
      const after = await this.prisma.savedBankAccount.update({ where: { id }, data: { removedAt, removedBy: by } });
      return { before: bankView(row), after: { ...bankView(after), removedAt: removedAt.toISOString(), removedBy: by }, label: `${row.bankName} ••••${row.accountNumber.slice(-4)}` };
    }
    const row = await this.prisma.savedCryptoAddress.findFirst({ where: { id, userId, removedAt: null } });
    if (!row) throw new NotFoundException('Saved address not found');
    const after = await this.prisma.savedCryptoAddress.update({ where: { id }, data: { removedAt, removedBy: by } });
    return {
      before: cryptoView(row, row.networkId),
      after: { ...cryptoView(after, after.networkId), removedAt: removedAt.toISOString(), removedBy: by },
      label: `${row.assetCode.toUpperCase()} (${row.address.slice(0, 6)}…${row.address.slice(-4)})`,
    };
  }
}
