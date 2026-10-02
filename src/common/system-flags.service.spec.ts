import { ForbiddenException } from '@nestjs/common';
import {
  NGN_WITHDRAWALS_FLAG,
  NGN_WITHDRAWALS_OFF_MESSAGE,
  SystemFlagsService,
} from './system-flags.service';

/**
 * The naira-withdrawal switch: NGN_WITHDRAWALS_ENABLED from the server, with an
 * optional admin override in system_flags that wins while it exists.
 *
 * The rules that matter are the fail-safe ones: no override follows the server
 * setting, only a literal `true` override means on, and a flip or a reset is
 * visible at once in the process that made it.
 */

type Row = { value: unknown; updatedBy: string | null; updatedAt: Date };

function flagsWith(opts: { rows?: Record<string, Row>; serverSetting?: boolean } = {}) {
  const table = new Map<string, Row>(Object.entries(opts.rows ?? {}));
  const prisma = {
    systemFlag: {
      findUnique: jest.fn(async ({ where }: { where: { key: string } }) => {
        const row = table.get(where.key);
        return row ? { key: where.key, ...row } : null;
      }),
      upsert: jest.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { key: string };
          create: { value: unknown; updatedBy: string };
          update: { value: unknown; updatedBy: string };
        }) => {
          const data = table.has(where.key) ? update : create;
          table.set(where.key, {
            value: data.value,
            updatedBy: data.updatedBy,
            updatedAt: new Date('2026-10-02T12:00:00Z'),
          });
        },
      ),
      deleteMany: jest.fn(async ({ where }: { where: { key: string } }) => ({
        count: table.delete(where.key) ? 1 : 0,
      })),
    },
  };
  const config = {
    get: (key: string) => (key === 'NGN_WITHDRAWALS_ENABLED' ? (opts.serverSetting ?? false) : undefined),
  };
  return new SystemFlagsService(prisma as never, config as never);
}

const override = (value: unknown): Record<string, Row> => ({
  [NGN_WITHDRAWALS_FLAG]: { value, updatedBy: 'admin-9', updatedAt: new Date('2026-10-01T08:00:00Z') },
});

describe('naira withdrawal switch', () => {
  it('is off when the server setting is off and nobody has overridden it', async () => {
    expect(await flagsWith().ngnWithdrawalsEnabled()).toBe(false);
  });

  it('follows the server setting when there is no override', async () => {
    expect(await flagsWith({ serverSetting: true }).ngnWithdrawalsEnabled()).toBe(true);
  });

  it('lets an override switch them on over a server setting that is off', async () => {
    expect(await flagsWith({ rows: override(true) }).ngnWithdrawalsEnabled()).toBe(true);
  });

  it('lets an override switch them off over a server setting that is on', async () => {
    const flags = flagsWith({ rows: override(false), serverSetting: true });
    expect(await flags.ngnWithdrawalsEnabled()).toBe(false);
  });

  it('treats any odd override value as off, so a hand-edited row fails safe', async () => {
    for (const odd of ['true', 1, 'yes', {}]) {
      const flags = flagsWith({ rows: override(odd), serverSetting: true });
      expect(await flags.ngnWithdrawalsEnabled()).toBe(false);
    }
  });

  it('refuses with the user-facing message while off', async () => {
    const flags = flagsWith();
    await expect(flags.assertNgnWithdrawalsAllowed()).rejects.toBeInstanceOf(ForbiddenException);
    await expect(flags.assertNgnWithdrawalsAllowed()).rejects.toThrow(NGN_WITHDRAWALS_OFF_MESSAGE);
  });

  it('lets requests through while on', async () => {
    await expect(flagsWith({ serverSetting: true }).assertNgnWithdrawalsAllowed()).resolves.toBeUndefined();
  });

  it('applies a flip and a reset at once in this process, despite the cache', async () => {
    const flags = flagsWith({ serverSetting: false });
    expect(await flags.ngnWithdrawalsEnabled()).toBe(false); // now cached
    await flags.setNgnWithdrawalsOverride(true, 'owner-1');
    expect(await flags.ngnWithdrawalsEnabled()).toBe(true);
    await flags.clearNgnWithdrawalsOverride('owner-1');
    expect(await flags.ngnWithdrawalsEnabled()).toBe(false); // back to the server setting
  });

  it('reports the server setting as the source when there is no override', async () => {
    expect(await flagsWith({ serverSetting: true }).ngnWithdrawalsState()).toEqual({
      enabled: true,
      source: 'server',
      serverSetting: true,
      updatedAt: null,
      updatedBy: null,
    });
  });

  it('reports an override, by whom and when, alongside the server setting', async () => {
    expect(await flagsWith({ rows: override(false), serverSetting: true }).ngnWithdrawalsState()).toEqual({
      enabled: false,
      source: 'override',
      serverSetting: true,
      updatedAt: new Date('2026-10-01T08:00:00Z'),
      updatedBy: 'admin-9',
    });
  });
});
