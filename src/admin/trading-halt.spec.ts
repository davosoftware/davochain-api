import { AdminController } from './admin.controller';
import { PERMISSIONS_KEY } from './require-permissions.decorator';
import { ALL_PERMISSIONS, DEFAULT_SUB_ADMIN_PERMISSIONS } from './permissions';
import { SystemFlagsService } from '../common/system-flags.service';

/**
 * M8 (PROJECT_REVIEW): pausing or resuming trading only needed fees.manage, so
 * anyone allowed to change fees could halt the exchange. And flags were cached
 * for 5 seconds in each server, so a pause reached servers unevenly.
 */
describe('M8: pausing trading is its own permission', () => {
  it('trading.halt exists, and no new sub-admin has it by default', () => {
    expect(ALL_PERMISSIONS).toContain('trading.halt');
    expect(DEFAULT_SUB_ADMIN_PERMISSIONS).not.toContain('trading.halt');
  });

  it.each(['pause', 'resume'])('POST /admin/%s needs trading.halt, not fees.manage', (route) => {
    const required = Reflect.getMetadata(PERMISSIONS_KEY, (AdminController.prototype as unknown as Record<string, () => void>)[route]);
    expect(required).toEqual(['trading.halt']);
  });
});

describe('M8: a pause takes effect at once on every server', () => {
  it('the money-path checks read the switch fresh, not from a 5-second memory', async () => {
    let paused: string[] = [];
    const prisma = { systemFlag: { findUnique: jest.fn(async ({ where }: { where: { key: string } }) => (where.key === 'paused_assets' ? { value: paused } : null)) } };
    const flags = new SystemFlagsService(prisma as never, { get: () => undefined } as never);
    await expect(flags.assertTradingAllowed('btc')).resolves.toBeUndefined();
    paused = ['btc']; // another server paused BTC a moment later
    await expect(flags.assertTradingAllowed('btc')).rejects.toMatchObject({ status: 403 });
  });

  it('the same goes for the deposit and withdrawal switches', async () => {
    let enabled = true;
    const prisma = { systemFlag: { findUnique: jest.fn(async () => ({ value: enabled })) } };
    const flags = new SystemFlagsService(prisma as never, { get: () => undefined } as never);
    await flags.assertWithdrawalsAllowed();
    await flags.assertDepositsAllowed();
    enabled = false;
    await expect(flags.assertWithdrawalsAllowed()).rejects.toMatchObject({ status: 403 });
    await expect(flags.assertDepositsAllowed()).rejects.toMatchObject({ status: 403 });
  });
});
