import { BadRequestException, Injectable } from '@nestjs/common';
import { LimitCurrency, PolicyAction, PolicyLevel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdminService } from '../admin/admin.service';
import { ACTIONS, LEVEL_TITLES } from './levels';

const AMOUNT = /^\d+(\.\d+)?$/;

export interface SaveLevelsInput {
  rules: Array<{ level: PolicyLevel; action: PolicyAction; allowed: boolean; currency: LimitCurrency; minPerTx: string | null; maxPerTx: string | null; maxPerDay: string | null }>;
  cooloffs: Array<{ level: PolicyLevel; afterSignupHours: number; afterCredentialChangeHours: number; afterNewPayeeHours: number }>;
  platform: { tradingMaxPerDay: string | null; currency: LimitCurrency };
}

@Injectable()
export class LevelAdminService {
  constructor(private readonly prisma: PrismaService, private readonly admin: AdminService) {}

  async view() {
    const [rules, cooloffs, platform] = await Promise.all([
      this.prisma.levelRule.findMany(),
      this.prisma.levelCooloff.findMany(),
      this.prisma.platformLimit.findUnique({ where: { id: 'default' } }),
    ]);
    const s = (v: unknown) => (v == null ? null : String(v));
    return {
      actions: (Object.keys(ACTIONS) as PolicyAction[]).map((a) => ({ action: a, label: ACTIONS[a].label, unit: ACTIONS[a].unit })),
      rules: rules.map((r) => ({ level: r.level, action: r.action, allowed: r.allowed, currency: r.currency, minPerTx: s(r.minPerTx), maxPerTx: s(r.maxPerTx), maxPerDay: s(r.maxPerDay) })),
      cooloffs: cooloffs.map((c) => ({ level: c.level, afterSignupHours: c.afterSignupHours, afterCredentialChangeHours: c.afterCredentialChangeHours, afterNewPayeeHours: c.afterNewPayeeHours })),
      platform: { tradingMaxPerDay: s(platform?.tradingMaxPerDay), currency: platform?.currency ?? 'USD' },
    };
  }

  private validate(input: SaveLevelsInput): void {
    for (const r of input.rules) {
      const where = `${LEVEL_TITLES[r.level]} · ${ACTIONS[r.action].label}`;
      const nums = [r.minPerTx, r.maxPerTx, r.maxPerDay];
      if (nums.some((n) => n != null && n !== '' && n.startsWith('-'))) throw new BadRequestException(`${where}: amounts cannot be negative.`);
      if (nums.some((n) => n != null && n !== '' && !AMOUNT.test(n))) throw new BadRequestException(`${where}: enter a plain number, e.g. 50000 or 50000.50.`);
      const [min, max, day] = nums.map((n) => (n == null || n === '' ? null : Number(n)));
      if (min != null && max != null && min > max) throw new BadRequestException(`${where}: the minimum is above the maximum per transaction.`);
      if (max != null && day != null && max > day) throw new BadRequestException(`${where}: the maximum per transaction is above the daily maximum.`);
    }
    for (const c of input.cooloffs) {
      if ([c.afterSignupHours, c.afterCredentialChangeHours, c.afterNewPayeeHours].some((h) => !Number.isInteger(h) || h < 0)) {
        throw new BadRequestException(`${LEVEL_TITLES[c.level]} · cool-offs: hours must be whole numbers, 0 or more.`);
      }
    }
    const p = input.platform.tradingMaxPerDay;
    if (p != null && p !== '' && !AMOUNT.test(p)) throw new BadRequestException('Platform limit: enter a plain number.');
  }

  async save(input: SaveLevelsInput, adminId: string) {
    this.validate(input);
    const before = await this.view();
    const blank = (v: string | null) => (v == null || v === '' ? null : v);
    await this.prisma.$transaction(async (t) => {
      for (const r of input.rules) {
        const data = { allowed: r.allowed, currency: r.currency, minPerTx: blank(r.minPerTx), maxPerTx: blank(r.maxPerTx), maxPerDay: blank(r.maxPerDay), updatedBy: adminId };
        await t.levelRule.upsert({ where: { level_action: { level: r.level, action: r.action } }, create: { level: r.level, action: r.action, ...data }, update: data });
      }
      for (const c of input.cooloffs) {
        const data = { afterSignupHours: c.afterSignupHours, afterCredentialChangeHours: c.afterCredentialChangeHours, afterNewPayeeHours: c.afterNewPayeeHours, updatedBy: adminId };
        await t.levelCooloff.upsert({ where: { level: c.level }, create: { level: c.level, ...data }, update: data });
      }
      const pdata = { tradingMaxPerDay: blank(input.platform.tradingMaxPerDay), currency: input.platform.currency, updatedBy: adminId };
      await t.platformLimit.upsert({ where: { id: 'default' }, create: { id: 'default', ...pdata }, update: pdata });
    });
    const after = await this.view();
    await this.admin.audit(adminId, 'levels.save', 'LevelRule', null, before, after);
    return after;
  }
}
