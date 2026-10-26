import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AddressStatus, type Prisma } from '@prisma/client';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AddressesService } from '../addresses/addresses.service';
import { PasswordService } from '../auth/password.service';
import { AdminService } from './admin.service';

/**
 * People → Crypto addresses (spec 2026-10-26 part 2): every customer's deposit
 * addresses, the stuck ones first to hand, and Check again / Try again. Also the
 * "Create in advance" switch per coin network (part 3).
 */

/** Still waiting after this long counts as stuck on the screen. */
const STUCK_AFTER_MS = 10 * 60_000;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const WRONG_PASSWORD = 'That password is not correct.';

export class DepositAddressParams {
  @IsOptional() @IsIn(['PENDING', 'ACTIVE', 'FAILED', 'DISABLED']) status?: string;
  @IsOptional() @Matches(/^[a-z0-9]{1,20}$/i) asset?: string;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsIn(['true', 'false']) stuck?: string;
  @IsOptional() @Matches(/^\d{1,6}$/) page?: string;
  @IsOptional() @Matches(/^\d{1,3}$/) pageSize?: string;
}

const whole = (v: string | undefined) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
};

const stuckWhere = (now: Date): Prisma.DepositAddressWhereInput[] => [
  { status: AddressStatus.FAILED },
  { status: AddressStatus.PENDING, requestedAt: { lt: new Date(now.getTime() - STUCK_AFTER_MS) } },
];

export function depositAddressQuery(p: DepositAddressParams, now = new Date()) {
  const page = whole(p.page) >= 1 ? whole(p.page) : 1;
  const size = whole(p.pageSize);
  const pageSize = size >= 1 ? Math.min(size, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  const search = (p.search ?? '').trim().slice(0, 100);

  const where: Prisma.DepositAddressWhereInput = {};
  if (p.asset) where.assetCode = p.asset.toLowerCase();
  if (p.status) where.status = p.status as AddressStatus;
  if (p.stuck === 'true') where.OR = stuckWhere(now);
  if (search) {
    where.user = {
      OR: [
        { email: { contains: search, mode: 'insensitive' } },
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
      ],
    };
  }
  return { page, pageSize, where, skip: (page - 1) * pageSize, take: pageSize };
}

type Row = Prisma.DepositAddressGetPayload<{
  include: { network: { select: { label: true } }; user: { select: { id: true; email: true; firstName: true; lastName: true } } };
}>;

export interface AdminAddressView {
  id: string;
  customer: { id: string; email: string; name: string };
  asset: string;
  network: string;
  networkLabel: string;
  status: AddressStatus;
  stuck: boolean;
  address: string | null;
  destinationTag: string | null;
  autoCreated: boolean;
  requestedAt: Date;
  activatedAt: Date | null;
  failedAt: Date | null;
}

const INCLUDE = {
  network: { select: { label: true } },
  user: { select: { id: true, email: true, firstName: true, lastName: true } },
} as const;

@Injectable()
export class DepositAddressesAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly addresses: AddressesService,
    private readonly admin: AdminService,
    private readonly passwords: PasswordService,
  ) {}

  async list(p: DepositAddressParams, now = new Date()) {
    const q = depositAddressQuery(p, now);
    const [rows, total, stuckCount] = await Promise.all([
      this.prisma.depositAddress.findMany({ where: q.where, include: INCLUDE, orderBy: { requestedAt: 'desc' }, skip: q.skip, take: q.take }),
      this.prisma.depositAddress.count({ where: q.where }),
      this.prisma.depositAddress.count({ where: { OR: stuckWhere(now) } }),
    ]);
    return { items: (rows as Row[]).map((r) => this.view(r, now)), total, stuckCount, page: q.page, pageSize: q.pageSize };
  }

  /** One customer's addresses, for the Users page's expanded row. */
  async forUser(userId: string, now = new Date()): Promise<AdminAddressView[]> {
    const rows = await this.prisma.depositAddress.findMany({
      where: { userId },
      include: INCLUDE,
      orderBy: [{ assetCode: 'asc' }, { networkId: 'asc' }],
    });
    return (rows as Row[]).map((r) => this.view(r, now));
  }

  /**
   * PENDING: ask Quidax now (never a new address). FAILED: the customer's own
   * Try again (a late address first, else one new request). Audited.
   */
  async retry(adminId: string, id: string, ip?: string): Promise<AdminAddressView> {
    const before = await this.load(id);
    if (before.status === AddressStatus.PENDING) {
      await this.addresses.resolve(id);
    } else if (before.status === AddressStatus.FAILED) {
      await this.addresses.getOrCreate(before.userId, before.assetCode, before.networkId, { auto: before.autoCreated });
    } else {
      throw new BadRequestException('This address is not waiting or failed, so there is nothing to try again.');
    }
    const after = await this.load(id);
    await this.admin.audit(adminId, 'deposit_address.retry', 'DepositAddress', id, { status: before.status }, { status: after.status }, ip);
    return this.view(after);
  }

  /** Coin networks open for deposits, with their "Create in advance" switch. */
  async networks() {
    const rows = await this.prisma.assetNetwork.findMany({
      where: { isListed: true, depositsEnabled: true },
      orderBy: [{ assetCode: 'asc' }, { networkId: 'asc' }],
    });
    return rows.map((n) => ({ asset: n.assetCode, network: n.networkId, label: n.label, autoCreate: n.autoCreate }));
  }

  async setAutoCreate(adminId: string, asset: string, network: string, enabled: boolean, password: string, ip?: string) {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId }, select: { passwordHash: true } });
    if (!admin || !(await this.passwords.verify(password, admin.passwordHash))) throw new BadRequestException(WRONG_PASSWORD);

    const where = { assetCode_networkId: { assetCode: asset.toLowerCase(), networkId: network } };
    const before = await this.prisma.assetNetwork.findUnique({ where });
    if (!before || !before.isListed) throw new NotFoundException(`${asset.toUpperCase()} is not listed on ${network}.`);
    if (enabled && !before.depositsEnabled) {
      throw new BadRequestException(`Deposits are off for ${asset.toUpperCase()} on ${before.label}, so its addresses can't be made in advance.`);
    }
    const after = await this.prisma.assetNetwork.update({ where, data: { autoCreate: enabled } });
    await this.admin.audit(adminId, 'asset_network.auto_create', 'AssetNetwork', `${after.assetCode}/${after.networkId}`, { autoCreate: before.autoCreate }, { autoCreate: after.autoCreate }, ip);
    return { asset: after.assetCode, network: after.networkId, label: after.label, autoCreate: after.autoCreate };
  }

  private async load(id: string): Promise<Row> {
    const row = await this.prisma.depositAddress.findUnique({ where: { id }, include: INCLUDE });
    if (!row) throw new NotFoundException('Address not found');
    return row as Row;
  }

  private view(r: Row, now = new Date()): AdminAddressView {
    const stuck =
      r.status === AddressStatus.FAILED ||
      (r.status === AddressStatus.PENDING && now.getTime() - r.requestedAt.getTime() > STUCK_AFTER_MS);
    return {
      id: r.id,
      customer: { id: r.user.id, email: r.user.email, name: `${r.user.firstName ?? ''} ${r.user.lastName ?? ''}`.trim() },
      asset: r.assetCode,
      network: r.networkId,
      networkLabel: r.network.label,
      status: r.status,
      stuck,
      address: r.address,
      destinationTag: r.destinationTag,
      autoCreated: r.autoCreated,
      requestedAt: r.requestedAt,
      activatedAt: r.activatedAt,
      failedAt: r.failedAt,
    };
  }
}
