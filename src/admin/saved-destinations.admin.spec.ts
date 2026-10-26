import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LevelAdminService } from '../levels/level-admin.service';
import { UsersAdminService } from './users-admin.service';
import { SavedDestinationsService } from '../withdrawals/saved-destinations.service';
import { RemoveDestinationDto } from './dto';
import { PERMISSIONS_KEY } from './require-permissions.decorator';

const NOW = new Date('2026-10-15T10:00:00Z');

function levelAdmin() {
  const saved: Array<Record<string, unknown>> = [];
  const t = {
    levelRule: { upsert: jest.fn(), findMany: jest.fn(async () => []) },
    levelCooloff: { upsert: jest.fn(), findMany: jest.fn(async () => []) },
    platformLimit: {
      upsert: jest.fn(async ({ update }: { update: Record<string, unknown> }) => saved.push(update)),
      findUnique: jest.fn(async () => ({ tradingMaxPerDay: null, currency: 'USD', maxSavedBankAccounts: 5, maxSavedCryptoAddresses: 10 })),
    },
  };
  const prisma = { ...t, $transaction: jest.fn((fn: (x: unknown) => unknown) => fn(t)) };
  return { svc: new LevelAdminService(prisma as never, { audit: jest.fn() } as never), saved };
}
const input = (caps: Record<string, unknown>) => ({ rules: [], cooloffs: [], platform: { tradingMaxPerDay: null, currency: 'USD', ...caps } });

describe('Admins set how many destinations a customer may save', () => {
  it('the caps are shown and saved with the rest of the levels', async () => {
    const { svc, saved } = levelAdmin();
    expect((await svc.view()).platform).toMatchObject({ maxSavedBankAccounts: 5, maxSavedCryptoAddresses: 10 });
    await svc.save(input({ maxSavedBankAccounts: 3, maxSavedCryptoAddresses: 7 }) as never, 'admin-1');
    expect(saved[0]).toMatchObject({ maxSavedBankAccounts: 3, maxSavedCryptoAddresses: 7 });
  });

  it.each([0, 51, 2.5])('refuses a cap of %s', async (bad) => {
    const { svc } = levelAdmin();
    await expect(svc.save(input({ maxSavedBankAccounts: bad, maxSavedCryptoAddresses: 10 }) as never, 'admin-1')).rejects.toThrow(
      new BadRequestException('Saved destinations: the maximum must be a whole number between 1 and 50.'),
    );
  });

  it('a save without the caps leaves them as they are', async () => {
    const { svc, saved } = levelAdmin();
    await svc.save({ rules: [], cooloffs: [], platform: { tradingMaxPerDay: null, currency: 'USD' } } as never, 'admin-1');
    expect(saved[0]).not.toHaveProperty('maxSavedBankAccounts');
  });
});

describe('Admins see and remove a customer\'s saved destinations', () => {
  it('the user details list live destinations, the bank number masked', async () => {
    const prisma = {
      user: { findUnique: jest.fn(async () => ({ id: 'u1', quidaxAccount: null, kycProfile: null })) },
      balance: { findMany: jest.fn(async () => []) },
      asset: { findMany: jest.fn(async () => []) },
      transaction: { count: jest.fn(async () => 0) },
      depositAddress: { findMany: jest.fn(async () => []) },
      savedBankAccount: { findMany: jest.fn(async () => [{ id: 'b1', bankCode: '058', bankName: 'GTBank', accountNumber: '0123451234', accountName: 'ADA', nickname: null, usableFrom: NOW, removedAt: null }]) },
      savedCryptoAddress: { findMany: jest.fn(async () => [{ id: 'c1', assetCode: 'btc', networkId: 'btc', address: 'bc1q', destinationTag: null, nickname: null, usableFrom: NOW }]) },
      assetNetwork: { findMany: jest.fn(async () => [{ assetCode: 'btc', networkId: 'btc', label: 'Bitcoin' }]) },
    };
    const svc = new UsersAdminService(prisma as never, {} as never, {} as never, {} as never);
    const d = await svc.detail('u1');
    expect(d.savedDestinations.bankAccounts[0]).toMatchObject({ id: 'b1', accountNumberMasked: '******1234' });
    expect(d.savedDestinations.bankAccounts[0]).not.toHaveProperty('accountNumber');
    expect(d.savedDestinations.cryptoAddresses[0]).toMatchObject({ id: 'c1', networkLabel: 'Bitcoin' });
    expect(prisma.savedBankAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u1', removedAt: null } }));
  });

  it('removing needs users.manage and a reason of 10+ characters', async () => {
    const { AdminController } = await import('./admin.controller');
    const perms = (name: string) => Reflect.getMetadata(PERMISSIONS_KEY, (AdminController.prototype as unknown as Record<string, () => void>)[name]);
    expect(perms('removeUserBankAccount')).toEqual(['users.manage']);
    expect(perms('removeUserCryptoAddress')).toEqual(['users.manage']);
    expect(await validate(plainToInstance(RemoveDestinationDto, { reason: 'too short' }))).not.toHaveLength(0);
    expect(await validate(plainToInstance(RemoveDestinationDto, { reason: 'Reported as fraud by the bank' }))).toHaveLength(0);
  });

  it('an admin removal records the admin and emails the customer with the reason', async () => {
    const row = { id: 'b1', userId: 'u1', bankCode: '058', bankName: 'GTBank', accountNumber: '0123451234', accountName: 'ADA', nickname: null, usableFrom: NOW, removedAt: null };
    const prisma = {
      savedBankAccount: {
        findFirst: jest.fn(async () => row),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data })),
      },
    };
    const notify = jest.fn(async () => undefined);
    const svc = new SavedDestinationsService(prisma as never, {} as never, {} as never, { notify } as never);
    const out = await svc.removeByAdmin('bank', 'u1', 'b1', 'admin-1', 'Reported as fraud by the bank');
    expect(prisma.savedBankAccount.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ removedBy: 'admin-1' }) }));
    expect(out.after).toMatchObject({ removedBy: 'admin-1' });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', type: 'security.destination_removed', email: { key: 'destination.removed', variables: { destination: 'GTBank ••••1234', reason: 'Reported as fraud by the bank' } } }),
    );
  });
});
