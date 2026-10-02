import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import { NGN_WITHDRAWALS_FLAG, SystemFlagsService } from '../common/system-flags.service';
import {
  IN_FLIGHT_CODE,
  NgnWithdrawalsService,
  OWNER_ONLY_ENABLE_MESSAGE,
  OWNER_ONLY_RESET_MESSAGE,
  WRONG_PASSWORD_MESSAGE,
} from './ngn-withdrawals.service';

/**
 * The admin side of the naira-withdrawal switch: who may flip it, the password
 * every change costs, the warning before stopping payouts that are mid-flight,
 * and what the audit log keeps (never the password). Proved against the real
 * SystemFlagsService over an in-memory override row.
 */
type Row = { value: unknown; updatedBy: string | null; updatedAt: Date };

const PASSWORD = 'correct horse 42';
const OWNER = { id: 'owner-1', role: AdminRole.OWNER };
const SUB = { id: 'sub-1', role: AdminRole.SUB_ADMIN };

function build(
  opts: { override?: boolean; serverSetting?: boolean; inFlight?: { count: number; total: string } } = {},
) {
  let row: Row | null =
    opts.override === undefined
      ? null
      : { value: opts.override, updatedBy: 'admin-0', updatedAt: new Date('2026-10-01T00:00:00Z') };

  const prisma = {
    systemFlag: {
      findUnique: jest.fn(async () => (row ? { key: NGN_WITHDRAWALS_FLAG, ...row } : null)),
      upsert: jest.fn(
        async ({
          create,
          update,
        }: {
          create: { value: unknown; updatedBy: string };
          update: { value: unknown; updatedBy: string };
        }) => {
          const data = row ? update : create;
          row = { value: data.value, updatedBy: data.updatedBy, updatedAt: new Date('2026-10-02T12:00:00Z') };
        },
      ),
      deleteMany: jest.fn(async () => {
        const had = row !== null;
        row = null;
        return { count: had ? 1 : 0 };
      }),
    },
    adminUser: {
      findUnique: jest.fn(
        async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
          const full: Record<string, string> = {
            id: where.id,
            name: `Name of ${where.id}`,
            email: `${where.id}@davochain.test`,
            passwordHash: 'stored-hash',
          };
          return select ? Object.fromEntries(Object.keys(select).map((k) => [k, full[k]])) : full;
        },
      ),
    },
    transaction: {
      aggregate: jest.fn(async () => ({
        _count: { _all: opts.inFlight?.count ?? 0 },
        _sum: { toAmount: opts.inFlight ? opts.inFlight.total : null },
      })),
    },
  };
  const config = {
    get: (k: string) => (k === 'NGN_WITHDRAWALS_ENABLED' ? (opts.serverSetting ?? false) : undefined),
  };
  const flags = new SystemFlagsService(prisma as never, config as never);
  const passwords = { verify: jest.fn(async (password: string) => password === PASSWORD) };
  const admin = { audit: jest.fn().mockResolvedValue(undefined) };
  const service = new NgnWithdrawalsService(flags, prisma as never, admin as never, passwords as never);
  return { service, flags, prisma, admin, passwords };
}

describe('view', () => {
  it('follows the server setting until overridden, and counts naira withdrawals still in progress', async () => {
    const { service, prisma } = build({ serverSetting: false });
    expect(await service.view()).toEqual({
      enabled: false,
      source: 'server',
      serverSetting: false,
      updatedAt: null,
      updatedBy: null,
      inFlight: { count: 0, totalNgn: '0.00' },
    });
    expect(prisma.transaction.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          type: 'WITHDRAWAL',
          fromAsset: 'ngn',
          status: { in: ['PENDING', 'PROCESSING', 'RECONCILING'] },
        },
      }),
    );
  });

  it('shows the server setting turning them on', async () => {
    const view = await build({ serverSetting: true }).service.view();
    expect(view).toEqual(expect.objectContaining({ enabled: true, source: 'server', serverSetting: true }));
  });

  it('names the admin behind an override', async () => {
    const view = await build({ override: true }).service.view();
    expect(view.source).toBe('override');
    expect(view.updatedBy).toEqual({ id: 'admin-0', name: 'Name of admin-0', email: 'admin-0@davochain.test' });
  });
});

describe('set', () => {
  it('lets a sub-admin switch them off with their password, audits why, and never stores the password', async () => {
    const { service, flags, admin } = build({ override: true });
    const after = await service.set(SUB, { enabled: false, password: PASSWORD, reason: '  provider outage ' }, '10.0.0.1');

    expect(after).toEqual(
      expect.objectContaining({
        enabled: false,
        source: 'override',
        updatedBy: { id: 'sub-1', name: 'Name of sub-1', email: 'sub-1@davochain.test' },
      }),
    );
    expect(await flags.ngnWithdrawalsEnabled()).toBe(false);
    expect(admin.audit).toHaveBeenCalledWith(
      'sub-1',
      'ngn_withdrawals.disable',
      'SystemFlag',
      NGN_WITHDRAWALS_FLAG,
      expect.objectContaining({ enabled: true }),
      expect.objectContaining({ enabled: false, reason: 'provider outage' }),
      '10.0.0.1',
    );
    expect(JSON.stringify(admin.audit.mock.calls)).not.toContain(PASSWORD);
  });

  it('refuses a wrong password with a 400 (not 401) and changes nothing', async () => {
    const { service, prisma, admin } = build({ override: true });
    const err = await service.set(SUB, { enabled: false, password: 'not it' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toBe(WRONG_PASSWORD_MESSAGE);
    expect(prisma.systemFlag.upsert).not.toHaveBeenCalled();
    expect(admin.audit).not.toHaveBeenCalled();
  });

  it('refuses a sub-admin switching them on, before even checking the password', async () => {
    const { service, passwords, prisma } = build({ override: false });
    const err = await service.set(SUB, { enabled: true, password: PASSWORD }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as Error).message).toBe(OWNER_ONLY_ENABLE_MESSAGE);
    expect(passwords.verify).not.toHaveBeenCalled();
    expect(prisma.systemFlag.upsert).not.toHaveBeenCalled();
  });

  it('stops to warn when naira withdrawals are in progress, and changes nothing', async () => {
    const { service, prisma } = build({ override: true, inFlight: { count: 2, total: '450000' } });
    const err = await service.set(SUB, { enabled: false, password: PASSWORD }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toEqual(
      expect.objectContaining({ code: IN_FLIGHT_CODE, count: 2, totalNgn: '450000.00' }),
    );
    expect(prisma.systemFlag.upsert).not.toHaveBeenCalled();
  });

  it('switches off once the warning is confirmed, and records how many were in progress', async () => {
    const { service, admin } = build({ override: true, inFlight: { count: 2, total: '450000' } });
    const after = await service.set(SUB, { enabled: false, password: PASSWORD, confirmInFlight: true });
    expect(after.enabled).toBe(false);
    expect(admin.audit).toHaveBeenCalledWith(
      'sub-1',
      'ngn_withdrawals.disable',
      'SystemFlag',
      NGN_WITHDRAWALS_FLAG,
      expect.objectContaining({ inFlight: { count: 2, totalNgn: '450000.00' } }),
      expect.anything(),
      undefined,
    );
  });

  it('lets an owner switch them on over a server setting that is off', async () => {
    const { service, flags, admin } = build({ serverSetting: false });
    const after = await service.set(OWNER, { enabled: true, password: PASSWORD });
    expect(after).toEqual(expect.objectContaining({ enabled: true, source: 'override', serverSetting: false }));
    expect(await flags.ngnWithdrawalsEnabled()).toBe(true);
    expect(admin.audit).toHaveBeenCalledWith(
      'owner-1',
      'ngn_withdrawals.enable',
      'SystemFlag',
      NGN_WITHDRAWALS_FLAG,
      expect.objectContaining({ enabled: false }),
      expect.objectContaining({ enabled: true, reason: null }),
      undefined,
    );
  });
});

describe('reset', () => {
  it('is owner-only', async () => {
    const err = await build({ override: true }).service.reset(SUB, { password: PASSWORD }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as Error).message).toBe(OWNER_ONLY_RESET_MESSAGE);
  });

  it('returns to the server setting and audits it', async () => {
    const { service, prisma, admin } = build({ override: true, serverSetting: false });
    const after = await service.reset(OWNER, { password: PASSWORD });
    expect(after).toEqual(expect.objectContaining({ enabled: false, source: 'server', updatedBy: null }));
    expect(prisma.systemFlag.deleteMany).toHaveBeenCalled();
    expect(admin.audit).toHaveBeenCalledWith(
      'owner-1',
      'ngn_withdrawals.reset',
      'SystemFlag',
      NGN_WITHDRAWALS_FLAG,
      expect.objectContaining({ source: 'override' }),
      expect.objectContaining({ source: 'server' }),
      undefined,
    );
  });

  it('warns first when resetting would switch off withdrawals that are in progress', async () => {
    const { service, prisma } = build({ override: true, serverSetting: false, inFlight: { count: 1, total: '5000' } });
    const err = await service.reset(OWNER, { password: PASSWORD }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(prisma.systemFlag.deleteMany).not.toHaveBeenCalled();
  });
});
