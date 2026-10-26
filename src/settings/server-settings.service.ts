import { BadRequestException, ForbiddenException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from '../auth/password.service';
import { MailService } from '../common/mail.service';
import { PayrepApi } from '../payrep/payrep.api';
import { SERVER_SETTINGS, SETTING_BY_KEY, type ServerSettingKey, type SettingDef } from './server-settings.registry';

/** The system_flags row the Server settings screen saves to. */
export const SERVER_SETTINGS_FLAG = 'server_settings';
/** "Customer sessions started at or before this moment are over" (sign out all customers). */
export const CUSTOMER_SESSIONS_FLAG = 'customer_sessions_valid_after';

/** Every server re-reads the screen's values this often; the one that saved them, at once. */
const REFRESH_MS = 10_000;
const WRONG_PASSWORD = 'That password is not correct.';

export interface SettingsActor {
  id: string;
  role: 'OWNER' | 'SUB_ADMIN' | string;
  email?: string;
  name?: string;
  ip?: string;
}

export interface SettingView {
  key: string;
  group: string;
  label: string;
  help: string;
  kind: string;
  unit: string | null;
  min: number | null;
  max: number | null;
  value: unknown;
  source: 'dashboard' | 'server';
  serverDefault: unknown;
  live: boolean;
  money: boolean;
}

/**
 * The Server settings screen (spec 2026-10-26): a value saved on the dashboard,
 * else the .env value. Owners only, with their password and a reason; audited;
 * owners emailed for the money-related ones. Reads are synchronous from a
 * snapshot refreshed every 10 seconds, so the code paths that use a setting
 * stay as cheap as reading .env was.
 */
@Injectable()
export class ServerSettingsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ServerSettingsService.name);
  private snapshot: Record<string, unknown> = {};
  private sessionsValidAfterMs: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly passwords: PasswordService,
    private readonly mail: MailService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Re-reads both rows. A value that is no longer valid is ignored for that setting only. */
  async refresh(): Promise<void> {
    try {
      const [row, cut] = await Promise.all([
        this.prisma.systemFlag.findUnique({ where: { key: SERVER_SETTINGS_FLAG } }),
        this.prisma.systemFlag.findUnique({ where: { key: CUSTOMER_SESSIONS_FLAG } }),
      ]);
      const stored = row?.value && typeof row.value === 'object' && !Array.isArray(row.value) ? (row.value as Record<string, unknown>) : {};
      const next: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(stored)) {
        const def = SETTING_BY_KEY.get(key);
        if (!def) continue;
        try {
          next[key] = this.shape(def, value);
        } catch {
          this.log.warn(`Ignoring the saved value of ${key}: it is no longer valid. The .env value applies.`);
        }
      }
      this.snapshot = next;
      const at = cut?.value && typeof cut.value === 'object' ? (cut.value as { at?: unknown }).at : null;
      this.sessionsValidAfterMs = typeof at === 'number' ? at : null;
    } catch (err) {
      // Keep the last good snapshot: a database blip must not flip every setting back to .env.
      this.log.error(`Could not refresh server settings: ${(err as Error).message}`);
    }
  }

  /** The value that applies now: set on the dashboard, else .env. Any other key reads .env directly. */
  get<T = unknown>(key: ServerSettingKey): T {
    if (SETTING_BY_KEY.has(key) && key in this.snapshot) return this.snapshot[key] as T;
    return this.config.get<T>(key) as T;
  }

  /** Customer tokens issued at or before this second are over (sign out all customers); null = no cut. */
  customerSessionsValidAfterSec(): number | null {
    return this.sessionsValidAfterMs === null ? null : Math.floor(this.sessionsValidAfterMs / 1000);
  }

  view(): SettingView[] {
    return SERVER_SETTINGS.map((d) => {
      const k = d.kind as { type: string; unit?: string; min?: number; max?: number };
      return {
        key: d.key,
        group: d.group,
        label: d.label,
        help: d.help,
        kind: d.kind.type,
        unit: k.unit ?? null,
        min: typeof k.min === 'number' ? k.min : null,
        max: typeof k.max === 'number' ? k.max : null,
        value: this.get(d.key as ServerSettingKey) ?? null,
        source: d.key in this.snapshot ? 'dashboard' : 'server',
        serverDefault: this.config.get(d.key) ?? null,
        live: d.live,
        money: d.money,
      };
    });
  }

  async set(actor: SettingsActor, key: ServerSettingKey, raw: unknown, password: string, reason: string): Promise<SettingView> {
    const def = this.definition(key);
    await this.assertOwner(actor, password, reason);
    const value = this.shape(def, raw);
    await this.deepCheck(def, value);
    if (key === 'QUOTE_TTL_SECONDS' || key === 'QUOTE_HARD_EXPIRY_SECONDS') {
      const ttl = key === 'QUOTE_TTL_SECONDS' ? (value as number) : this.get<number>('QUOTE_TTL_SECONDS');
      const hard = key === 'QUOTE_HARD_EXPIRY_SECONDS' ? (value as number) : this.get<number>('QUOTE_HARD_EXPIRY_SECONDS');
      if (typeof ttl === 'number' && typeof hard === 'number' && ttl > hard) {
        throw new BadRequestException(`The quote lifetime (${ttl} s) can't be longer than the quote hard expiry (${hard} s).`);
      }
    }
    return this.save(actor, def, { kind: 'set', value }, reason);
  }

  async reset(actor: SettingsActor, key: ServerSettingKey, password: string, reason: string): Promise<SettingView> {
    const def = this.definition(key);
    await this.assertOwner(actor, password, reason);
    return this.save(actor, def, { kind: 'reset' }, reason);
  }

  /**
   * Emergency (spec 2026-10-26 §3): every customer session ends now. Access
   * tokens issued at or before this second are refused by JwtAuthGuard, and
   * every customer refresh token is revoked. Admins are not affected.
   */
  async signOutAllCustomers(actor: SettingsActor, password: string, reason: string): Promise<{ signedOutAt: string; refreshTokensRevoked: number }> {
    await this.assertOwner(actor, password, reason);
    const now = new Date();
    const revoked = await this.prisma.$transaction(async (t) => {
      await t.systemFlag.upsert({
        where: { key: CUSTOMER_SESSIONS_FLAG },
        create: { key: CUSTOMER_SESSIONS_FLAG, value: { at: now.getTime() }, updatedBy: actor.id },
        update: { value: { at: now.getTime() }, updatedBy: actor.id },
      });
      const r = await t.refreshToken.updateMany({ where: { revokedAt: null }, data: { revokedAt: now } });
      await t.adminAuditLog.create({
        data: {
          adminUserId: actor.id,
          action: 'emergency.sign_out_customers',
          entity: 'Emergency',
          entityId: 'customers',
          before: Prisma.JsonNull,
          after: { signedOutAt: now.toISOString(), refreshTokensRevoked: r.count, reason },
          ip: actor.ip ?? null,
        },
      });
      return r.count;
    });
    this.sessionsValidAfterMs = now.getTime();
    await this.emailOwners(
      'All customers were signed out',
      [
        `${actor.name ?? actor.email ?? actor.id} signed out every customer at ${now.toISOString()}.`,
        `Reason: ${reason}`,
        `${revoked} saved session(s) ended. Customers sign in again with their password; money already in progress carries on.`,
      ],
    );
    return { signedOutAt: now.toISOString(), refreshTokensRevoked: revoked };
  }

  // ── internals ─────────────────────────────────────────────

  private definition(key: string): SettingDef {
    const def = SETTING_BY_KEY.get(key);
    if (!def) throw new BadRequestException(`${key} can't be changed here. It stays in the server's .env file.`);
    return def;
  }

  private async assertOwner(actor: SettingsActor, password: string, reason: string): Promise<void> {
    if (actor.role !== 'OWNER') throw new ForbiddenException('Only an owner can change server settings.');
    if (typeof reason !== 'string' || reason.trim().length < 10) {
      throw new BadRequestException('Say why, in at least 10 characters. It goes in the audit log.');
    }
    const admin = await this.prisma.adminUser.findUnique({ where: { id: actor.id }, select: { passwordHash: true } });
    if (!admin || typeof password !== 'string' || !(await this.passwords.verify(password, admin.passwordHash))) {
      throw new BadRequestException(WRONG_PASSWORD);
    }
  }

  /** Checks a value against the setting's rules and returns it in its stored form. Throws a message a person can act on. */
  private shape(def: SettingDef, raw: unknown): unknown {
    const k = def.kind;
    const bad = (msg: string) => new BadRequestException(`${def.label}: ${msg}`);
    switch (k.type) {
      case 'boolean':
        if (typeof raw !== 'boolean') throw bad('choose on or off.');
        return raw;
      case 'int': {
        const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < k.min || n > k.max) throw bad(`enter a whole number from ${k.min} to ${k.max}${k.unit ? ` ${k.unit}` : ''}.`);
        return n;
      }
      case 'decimal': {
        const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
        if (typeof n !== 'number' || !Number.isFinite(n) || n < k.min || n > k.max) throw bad(`enter a number from ${k.min} to ${k.max}${k.unit ? ` ${k.unit}` : ''}.`);
        return n;
      }
      case 'duration': {
        const m = typeof raw === 'string' ? /^(\d{1,4})([mhd])$/.exec(raw.trim()) : null;
        const mult = { m: 60, h: 3600, d: 86400 } as const;
        const unitOk = m && (k.units as string[]).includes(m[2]);
        const secs = m ? Number(m[1]) * mult[m[2] as 'm' | 'h' | 'd'] : NaN;
        if (!m || !unitOk || secs < k.minSeconds || secs > k.maxSeconds) {
          throw bad(`write it like ${k.units.map((u) => `${u === 'd' ? 30 : u === 'h' ? 8 : 15}${u}`).join(' or ')}, between ${human(k.minSeconds)} and ${human(k.maxSeconds)}.`);
        }
        return `${Number(m[1])}${m[2]}`;
      }
      case 'string': {
        if (typeof raw !== 'string') throw bad('enter some text.');
        const v = raw.trim();
        if (!v && !k.allowEmpty) throw bad("can't be empty.");
        if (v.length > k.maxLength) throw bad(`at most ${k.maxLength} characters.`);
        if (v && k.pattern && !k.pattern.test(v)) throw bad(k.patternMessage ?? 'that is not in the right form.');
        return v;
      }
      case 'account':
        if (typeof raw !== 'string' || !/^\d{10}$/.test(raw.trim())) throw bad('enter the 10-digit account number.');
        return raw.trim();
      case 'timezone': {
        const v = typeof raw === 'string' ? raw.trim() : '';
        try {
          if (!v) throw new Error('empty');
          new Intl.DateTimeFormat('en-GB', { timeZone: v });
        } catch {
          throw bad('enter a time zone like Africa/Lagos.');
        }
        return v;
      }
      case 'asset': {
        const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
        if (!/^[a-z0-9]{2,10}$/.test(v)) throw bad('enter a coin code like usdt.');
        return v;
      }
    }
  }

  /** The checks that need another system: Payrep must know the account; we must list the coin. */
  private async deepCheck(def: SettingDef, value: unknown): Promise<void> {
    if (def.kind.type === 'account') {
      const payrep = this.payrepApi();
      if (payrep) {
        try {
          await payrep.account(value as string);
        } catch {
          throw new BadRequestException(`${def.label}: Payrep doesn't recognise account ${value as string}. Check the number on the Payrep dashboard.`);
        }
      }
    }
    if (def.kind.type === 'asset') {
      const asset = await this.prisma.asset.findUnique({ where: { code: value as string } });
      if (!asset) throw new BadRequestException(`${def.label}: we don't list ${(value as string).toUpperCase()}.`);
    }
  }

  private payrepApi(): PayrepApi | null {
    try {
      return this.moduleRef.get(PayrepApi, { strict: false });
    } catch {
      return null;
    }
  }

  private async save(actor: SettingsActor, def: SettingDef, change: { kind: 'set'; value: unknown } | { kind: 'reset' }, reason: string): Promise<SettingView> {
    const beforeView = this.view().find((v) => v.key === def.key)!;
    const row = await this.prisma.systemFlag.findUnique({ where: { key: SERVER_SETTINGS_FLAG } });
    const stored = row?.value && typeof row.value === 'object' && !Array.isArray(row.value) ? { ...(row.value as Record<string, unknown>) } : {};
    if (change.kind === 'set') stored[def.key] = change.value;
    else delete stored[def.key];
    const json = stored as Prisma.InputJsonValue;
    await this.prisma.systemFlag.upsert({
      where: { key: SERVER_SETTINGS_FLAG },
      create: { key: SERVER_SETTINGS_FLAG, value: json, updatedBy: actor.id },
      update: { value: json, updatedBy: actor.id },
    });
    if (change.kind === 'set') this.snapshot = { ...this.snapshot, [def.key]: change.value };
    else {
      const next = { ...this.snapshot };
      delete next[def.key];
      this.snapshot = next;
    }
    const afterView = this.view().find((v) => v.key === def.key)!;

    await this.prisma.adminAuditLog.create({
      data: {
        adminUserId: actor.id,
        action: change.kind === 'set' ? 'server_setting.set' : 'server_setting.reset',
        entity: 'ServerSetting',
        entityId: def.key,
        before: { value: beforeView.value as Prisma.InputJsonValue, source: beforeView.source },
        after: { value: afterView.value as Prisma.InputJsonValue, source: afterView.source, reason },
        ip: actor.ip ?? null,
      },
    });

    if (def.money) {
      await this.emailOwners(`${def.label} was changed`, [
        `${actor.name ?? actor.email ?? actor.id} changed "${def.label}" (${def.key}).`,
        `Before: ${show(beforeView.value)} (${beforeView.source === 'dashboard' ? 'set on the dashboard' : 'server default'})`,
        `After: ${show(afterView.value)} (${afterView.source === 'dashboard' ? 'set on the dashboard' : 'server default'})`,
        `Reason: ${reason}`,
      ]);
    }
    return afterView;
  }

  /** Never fails the change itself: the audit log already holds it. */
  private async emailOwners(subject: string, lines: string[]): Promise<void> {
    try {
      const owners = await this.prisma.adminUser.findMany({ where: { role: 'OWNER', isActive: true }, select: { email: true } });
      const text = [...lines, '', 'If this was not expected, sign in to the dashboard and check System → Server settings and the audit log.'].join('\n');
      const html = `<p>${text.split('\n').map(escapeHtml).join('<br>')}</p>`;
      for (const o of owners) {
        await this.mail.send({ to: o.email, subject: `[DavoChain] ${subject}`, text, html, templateKey: 'server-settings' }).catch(() => false);
      }
    } catch (err) {
      this.log.error(`Could not email owners about "${subject}": ${(err as Error).message}`);
    }
  }
}

const human = (secs: number) =>
  secs % 86400 === 0 ? `${secs / 86400} day(s)` : secs % 3600 === 0 ? `${secs / 3600} hour(s)` : `${Math.round(secs / 60)} minutes`;
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '(empty)' : typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v));
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
