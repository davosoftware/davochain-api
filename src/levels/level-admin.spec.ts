import { BadRequestException } from '@nestjs/common';
import { LevelAdminService } from './level-admin.service';

const valid = () => ({
  rules: [{ level: 'BASIC', action: 'GIFTCARD_SELL', allowed: true, currency: 'NGN', minPerTx: '5000', maxPerTx: '500000', maxPerDay: '1000000' }],
  cooloffs: [{ level: 'BASIC', afterSignupHours: 24, afterCredentialChangeHours: 48, afterNewPayeeHours: 24 }],
  platform: { tradingMaxPerDay: '50000', currency: 'USD' },
});

function build() {
  const writes: string[] = [];
  const t = {
    levelRule: { upsert: jest.fn(async () => writes.push('rule')), findMany: jest.fn(async () => []) },
    levelCooloff: { upsert: jest.fn(async () => writes.push('cooloff')), findMany: jest.fn(async () => []) },
    platformLimit: { upsert: jest.fn(async () => writes.push('platform')), findUnique: jest.fn(async () => null) },
  };
  const audit = jest.fn(async () => undefined);
  const prisma = { ...t, $transaction: jest.fn((fn: (x: unknown) => unknown) => fn(t)) };
  return { svc: new LevelAdminService(prisma as never, { audit } as never), writes, audit };
}

describe('Saving the level rules', () => {
  it('saves rules, cool-offs and the platform limit in one transaction, audited before -> after', async () => {
    const { svc, writes, audit } = build();
    await svc.save(valid() as never, 'admin-1');
    expect(writes).toEqual(['rule', 'cooloff', 'platform']);
    expect(audit).toHaveBeenCalledWith('admin-1', 'levels.save', 'LevelRule', null, expect.anything(), expect.anything());
  });

  it.each([
    ['min above max', { minPerTx: '600000' }, 'Basic · sell gift cards: the minimum is above the maximum per transaction.'],
    ['max above daily', { maxPerTx: '2000000' }, 'Basic · sell gift cards: the maximum per transaction is above the daily maximum.'],
    ['negative', { maxPerDay: '-1' }, 'Basic · sell gift cards: amounts cannot be negative.'],
    ['not a number', { minPerTx: 'abc' }, 'Basic · sell gift cards: enter a plain number, e.g. 50000 or 50000.50.'],
  ])('refuses %s, saving nothing', async (_n, change, message) => {
    const { svc, writes } = build();
    const input = valid();
    Object.assign(input.rules[0], change);
    await expect(svc.save(input as never, 'admin-1')).rejects.toThrow(new BadRequestException(message));
    expect(writes).toEqual([]);
  });

  it('refuses negative cool-off hours', async () => {
    const { svc } = build();
    const input = valid();
    input.cooloffs[0].afterSignupHours = -1;
    await expect(svc.save(input as never, 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('Who may see and change the levels', () => {
  it('GET levels needs levels.view; PUT levels needs levels.manage; kyc.limits is gone', async () => {
    const { AdminController } = await import('../admin/admin.controller');
    const { PERMISSIONS_KEY } = await import('../admin/require-permissions.decorator');
    const { ALL_PERMISSIONS } = await import('../admin/permissions');
    const route = (name: string) => Reflect.getMetadata(PERMISSIONS_KEY, (AdminController.prototype as unknown as Record<string, () => void>)[name]);
    expect(route('levels')).toEqual(['levels.view']);
    expect(route('saveLevels')).toEqual(['levels.manage']);
    expect(ALL_PERMISSIONS).not.toContain('kyc.limits');
  });
});
