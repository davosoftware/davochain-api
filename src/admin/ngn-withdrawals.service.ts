import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { AdminRole, TxStatus, TxType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from '../auth/password.service';
import {
  NGN_WITHDRAWALS_FLAG,
  SystemFlagsService,
  type NgnWithdrawalsState,
} from '../common/system-flags.service';
import { dec } from '../common/money';
import { AdminService } from './admin.service';

export const OWNER_ONLY_ENABLE_MESSAGE = 'Only an owner can switch naira withdrawals back on.';
export const OWNER_ONLY_RESET_MESSAGE = 'Only an owner can reset naira withdrawals to the server setting.';
/** 400, not 401: the dashboard reads a 401 as "signed out" and ends the session. */
export const WRONG_PASSWORD_MESSAGE = 'That password is not correct.';
export const IN_FLIGHT_CODE = 'NGN_WITHDRAWALS_IN_FLIGHT';

/** Naira withdrawals that have left the user's balance but not yet settled. */
const IN_FLIGHT_STATUSES: TxStatus[] = [TxStatus.PENDING, TxStatus.PROCESSING, TxStatus.RECONCILING];

export interface NgnInFlight {
  count: number;
  /** Naira on its way to banks, 2dp. */
  totalNgn: string;
}

export interface NgnWithdrawalsView {
  enabled: boolean;
  source: NgnWithdrawalsState['source'];
  serverSetting: boolean;
  updatedAt: Date | null;
  updatedBy: { id: string; name: string; email: string } | null;
  inFlight: NgnInFlight;
}

interface Actor {
  id: string;
  role: AdminRole;
}

/**
 * The dashboard's naira-withdrawal switch.
 *
 * Every change costs the admin's password. Anyone granted `withdrawals.manage`
 * may stop payouts — stopping is the safe direction — but only an owner may
 * start them again or hand control back to NGN_WITHDRAWALS_ENABLED. Stopping
 * while payouts are mid-flight answers 409 first: switching off blocks new
 * withdrawals only, and the admin should know some are still on their way.
 */
@Injectable()
export class NgnWithdrawalsService {
  constructor(
    private readonly flags: SystemFlagsService,
    private readonly prisma: PrismaService,
    private readonly admin: AdminService,
    private readonly passwords: PasswordService,
  ) {}

  async inFlight(): Promise<NgnInFlight> {
    const agg = await this.prisma.transaction.aggregate({
      where: { type: TxType.WITHDRAWAL, fromAsset: 'ngn', status: { in: IN_FLIGHT_STATUSES } },
      _count: { _all: true },
      _sum: { toAmount: true },
    });
    return { count: agg._count._all, totalNgn: dec(agg._sum.toAmount ?? 0).toFixed(2) };
  }

  async view(): Promise<NgnWithdrawalsView> {
    const [state, inFlight] = await Promise.all([this.flags.ngnWithdrawalsState(), this.inFlight()]);
    const updatedBy = state.updatedBy
      ? await this.prisma.adminUser.findUnique({
          where: { id: state.updatedBy },
          select: { id: true, name: true, email: true },
        })
      : null;
    return {
      enabled: state.enabled,
      source: state.source,
      serverSetting: state.serverSetting,
      updatedAt: state.updatedAt,
      updatedBy,
      inFlight,
    };
  }

  async set(
    actor: Actor,
    input: { enabled: boolean; password: string; reason?: string; confirmInFlight?: boolean },
    ip?: string,
  ): Promise<NgnWithdrawalsView> {
    if (input.enabled && actor.role !== AdminRole.OWNER) {
      throw new ForbiddenException(OWNER_ONLY_ENABLE_MESSAGE);
    }
    await this.assertPassword(actor.id, input.password);

    const before = await this.view();
    if (!input.enabled && before.inFlight.count > 0 && !input.confirmInFlight) {
      throw this.inFlightConflict(before.inFlight);
    }

    await this.flags.setNgnWithdrawalsOverride(input.enabled, actor.id);
    const after = await this.view();
    await this.admin.audit(
      actor.id,
      input.enabled ? 'ngn_withdrawals.enable' : 'ngn_withdrawals.disable',
      'SystemFlag',
      NGN_WITHDRAWALS_FLAG,
      before,
      { ...after, reason: input.reason?.trim() || null },
      ip,
    );
    return after;
  }

  /** Drop the dashboard override, so NGN_WITHDRAWALS_ENABLED decides again. */
  async reset(
    actor: Actor,
    input: { password: string; reason?: string; confirmInFlight?: boolean },
    ip?: string,
  ): Promise<NgnWithdrawalsView> {
    if (actor.role !== AdminRole.OWNER) throw new ForbiddenException(OWNER_ONLY_RESET_MESSAGE);
    await this.assertPassword(actor.id, input.password);

    const before = await this.view();
    const switchesOff = before.enabled && !before.serverSetting;
    if (switchesOff && before.inFlight.count > 0 && !input.confirmInFlight) {
      throw this.inFlightConflict(before.inFlight);
    }

    await this.flags.clearNgnWithdrawalsOverride(actor.id);
    const after = await this.view();
    await this.admin.audit(
      actor.id,
      'ngn_withdrawals.reset',
      'SystemFlag',
      NGN_WITHDRAWALS_FLAG,
      before,
      { ...after, reason: input.reason?.trim() || null },
      ip,
    );
    return after;
  }

  private async assertPassword(adminId: string, password: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminId },
      select: { passwordHash: true },
    });
    if (!admin || !(await this.passwords.verify(password, admin.passwordHash))) {
      throw new BadRequestException(WRONG_PASSWORD_MESSAGE);
    }
  }

  private inFlightConflict(inFlight: NgnInFlight): ConflictException {
    const message =
      inFlight.count === 1
        ? 'There is 1 naira withdrawal in progress. Switching off will not cancel it; confirm to continue.'
        : `There are ${inFlight.count} naira withdrawals in progress. Switching off will not cancel them; confirm to continue.`;
    return new ConflictException({ code: IN_FLIGHT_CODE, message, ...inFlight });
  }
}
