import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { AdminRole, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from '../auth/password.service';
import { ADVANCED_DEFAULTS, DojahConfig, DOJAH_SETTINGS_FLAG } from '../dojah/dojah.config';
import { DojahReadinessService } from '../dojah/dojah-readiness.service';
import { dojahThresholds } from '../dojah/threshold';
import { WRONG_PASSWORD_MESSAGE } from './ngn-withdrawals.service';

/** null = go back to the server default for that field. */
export type DojahSettingsPatch = Partial<Record<'minBalance' | 'lowBalanceWarn' | 'dailyAttempts' | 'totalAttempts', number | null>>;

const MSG_AMOUNT = 'Enter a whole naira amount, 0 or more.';
const MSG_WARN = 'The warning level must be higher than the hard stop.';
const MSG_TRIES = "Tries must be whole numbers from 1 to 20, and the daily number can't be more than the total.";
const naira = (n: number) => '₦' + n.toLocaleString('en-NG');

export type AdvancedSettingsPatch = Partial<
  Record<'advancedDailyAttempts' | 'advancedTotalAttempts' | 'livenessMin' | 'faceMatchPass' | 'faceMatchReview' | 'addressRecencyMonths', number | null>
>;
const MSG_FACE = 'The face-match review floor must be between 60 and the pass mark.';
const ADVANCED_RANGE: Record<keyof AdvancedSettingsPatch, [number, number, string]> = {
  advancedDailyAttempts: [1, 20, MSG_TRIES],
  advancedTotalAttempts: [1, 20, MSG_TRIES],
  livenessMin: [50, 100, 'The liveness score must be a whole number from 50 to 100.'],
  faceMatchPass: [60, 100, 'The face-match pass mark must be a whole number from 60 to 100.'],
  faceMatchReview: [60, 100, MSG_FACE],
  addressRecencyMonths: [1, 12, 'Months must be a whole number from 1 to 12.'],
};

/**
 * The Dojah screen's settings (decision 15 Oct): the hard stop, warning level
 * and tries are set here by anyone with "Edit site settings"; the Basic switch
 * by owners only, with their password, and only on when every check passes.
 * Saved in one system_flags row; DojahConfig.effective() reads it.
 */
@Injectable()
export class DojahSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: DojahConfig,
    private readonly readiness: DojahReadinessService,
    private readonly passwords: PasswordService,
  ) {}

  private async stored(): Promise<Record<string, unknown>> {
    const row = await this.prisma.systemFlag.findUnique({ where: { key: DOJAH_SETTINGS_FLAG } });
    return row?.value && typeof row.value === 'object' ? { ...(row.value as Record<string, unknown>) } : {};
  }

  private async write(value: Record<string, unknown>, adminId: string): Promise<void> {
    const json = value as Prisma.InputJsonValue;
    await this.prisma.systemFlag.upsert({
      where: { key: DOJAH_SETTINGS_FLAG },
      create: { key: DOJAH_SETTINGS_FLAG, value: json, updatedBy: adminId },
      update: { value: json, updatedBy: adminId },
    });
    // The next look at the screen (and the next verification) sees the change.
    this.readiness.invalidate();
  }

  /** Returns the settings before and after, for the audit log. */
  async saveSettings(adminId: string, patch: DojahSettingsPatch) {
    const whole = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
    for (const key of ['minBalance', 'lowBalanceWarn'] as const) {
      if (patch[key] !== undefined && patch[key] !== null && !whole(patch[key], 0)) throw new BadRequestException(MSG_AMOUNT);
    }
    for (const key of ['dailyAttempts', 'totalAttempts'] as const) {
      if (patch[key] !== undefined && patch[key] !== null && !whole(patch[key], 1, 20)) throw new BadRequestException(MSG_TRIES);
    }

    const before = await this.stored();
    const next: Record<string, unknown> = { ...before };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value === null) delete next[key];
      else next[key] = value;
    }

    // Check the numbers that will actually apply: a field not set here uses the server default.
    const server: Record<string, number | null> = {
      minBalance: this.cfg.minBalance,
      lowBalanceWarn: this.cfg.lowBalanceWarn,
      dailyAttempts: this.cfg.dailyAttempts,
      totalAttempts: this.cfg.totalAttempts,
    };
    const applies = (key: string) => (key in next ? (next[key] as number) : server[key]);
    const minBalance = applies('minBalance') ?? 0;
    const warn = applies('lowBalanceWarn');
    if (warn !== null && warn <= minBalance) throw new BadRequestException(MSG_WARN);
    if ((applies('dailyAttempts') as number) > (applies('totalAttempts') as number)) throw new BadRequestException(MSG_TRIES);

    await this.write(next, adminId);
    return { before, after: next };
  }

  private async assertOwnerWithPassword(actor: { id: string; role: AdminRole }, password: string, what: string): Promise<void> {
    if (actor.role !== AdminRole.OWNER) throw new ForbiddenException(`Only an owner can ${what}`);
    const admin = await this.prisma.adminUser.findUnique({ where: { id: actor.id }, select: { passwordHash: true } });
    if (!admin || !(await this.passwords.verify(password, admin.passwordHash))) {
      throw new BadRequestException(WRONG_PASSWORD_MESSAGE);
    }
  }

  /**
   * The Advanced checks' numbers (spec 2026-10-21 §5.3). Owners only, with their
   * password: these decide who is approved without a person looking.
   */
  async saveAdvancedSettings(actor: { id: string; role: AdminRole }, input: AdvancedSettingsPatch & { password: string }) {
    const { password, ...patch } = input;
    await this.assertOwnerWithPassword(actor, password, 'change the Advanced checks');
    for (const [key, value] of Object.entries(patch) as [keyof AdvancedSettingsPatch, number | null | undefined][]) {
      if (value === undefined || value === null) continue;
      const range = ADVANCED_RANGE[key];
      if (!range) continue;
      const [min, max, msg] = range;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new BadRequestException(msg);
    }
    const before = await this.stored();
    const next: Record<string, unknown> = { ...before };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || !(key in ADVANCED_RANGE)) continue;
      if (value === null) delete next[key];
      else next[key] = value;
    }
    const applies = (key: keyof typeof ADVANCED_DEFAULTS) => (key in next ? (next[key] as number) : ADVANCED_DEFAULTS[key]);
    if (applies('faceMatchReview') > applies('faceMatchPass')) throw new BadRequestException(MSG_FACE);
    if (applies('advancedDailyAttempts') > applies('advancedTotalAttempts')) throw new BadRequestException(MSG_TRIES);
    await this.write(next, actor.id);
    return { before, after: next };
  }

  /** Advanced on, off, or back to the server default (null). Owners only, password, "on" only when ready. */
  async setAdvancedSwitch(actor: { id: string; role: AdminRole }, input: { enabled: boolean | null; password: string }) {
    await this.assertOwnerWithPassword(actor, input.password, 'switch Advanced verification on or off');
    if (input.enabled === true) {
      const report = await this.readiness.report(true);
      if (!report.ready) {
        const failing = report.checks.filter((c) => c.required && !c.ok).map((c) => c.detail);
        throw new ConflictException(`Advanced can't be switched on yet: ${failing.join('; ')}.`);
      }
    }
    const before = await this.stored();
    const next = { ...before };
    if (input.enabled === null) delete next.advancedEnabled;
    else next.advancedEnabled = input.enabled;
    await this.write(next, actor.id);
    return { before, after: next };
  }

  /** enabled null = back to the server default. Owners only, password, and "on" only when ready. */
  async setBasicSwitch(actor: { id: string; role: AdminRole }, input: { enabled: boolean | null; password: string }) {
    await this.assertOwnerWithPassword(actor, input.password, 'switch Basic verification on or off');
    if (input.enabled === true) {
      const report = await this.readiness.report(true);
      if (!report.ready) {
        const failing = report.checks.filter((c) => c.required && !c.ok).map((c) => c.detail);
        throw new ConflictException(`Basic can't be switched on yet: ${failing.join('; ')}.`);
      }
    }
    const before = await this.stored();
    const next = { ...before };
    if (input.enabled === null) delete next.basicEnabled;
    else next.basicEnabled = input.enabled;
    await this.write(next, actor.id);
    return { before, after: next };
  }

  /** The calculator: suggested hard stop and warning from Dojah's prices and the busiest hour and day. Saves nothing. */
  async suggest(input: { lookupPrice: number; amlPrice: number; leadDays?: number; advancedPrice?: number }) {
    const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
    if (!ok(input.lookupPrice) || !ok(input.amlPrice)) throw new BadRequestException('Enter the price per check and per screening in naira.');
    const leadDays = ok(input.leadDays) ? Math.round(input.leadDays as number) : 3;
    const { observed } = await this.readiness.report();
    const peakHour = Math.max(observed.peakHour7d, 1);
    const peakDay = Math.max(observed.peakDay7d, 1);
    const advancedPrice = ok(input.advancedPrice) ? (input.advancedPrice as number) : undefined;
    const r = dojahThresholds({ lookupPrice: input.lookupPrice, amlPrice: input.amlPrice, advancedPrice, peakHour, peakDay, leadDays });
    const buffer = Math.max(peakHour, 20);
    return {
      minBalance: r.minBalance,
      lowBalanceWarn: r.lowBalanceWarn,
      workings: [
        `One verification can cost up to ${naira(r.perVerification)} (one BVN/NIN check at ${naira(input.lookupPrice)} plus up to two screenings at ${naira(input.amlPrice)}${advancedPrice ? `, plus up to four Advanced checks at ${naira(advancedPrice)} each` : ''}).`,
        `Hard stop: enough for ${buffer} verifications in an hour (your busiest hour in the last 7 days had ${observed.peakHour7d}; we never plan for fewer than 20), rounded up: ${naira(r.minBalance)}.`,
        `Warning level: the hard stop plus ${leadDays} days of your busiest day (${observed.peakDay7d} verifications), rounded up: ${naira(r.lowBalanceWarn)}.`,
      ],
    };
  }
}
