import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { ServiceUnavailableException } from '@nestjs/common';
import { MaintenanceGuard, PAUSED_IN_MAINTENANCE, MAINTENANCE_DEFAULT_MESSAGE } from './maintenance.guard';
import { QuotesController } from '../quotes/quotes.controller';
import { WithdrawalsController } from '../withdrawals/withdrawals.controller';
import { AddressesController } from '../addresses/addresses.controller';
import { VirtualAccountsController } from '../ngn-deposits/virtual-accounts.controller';
import { GiftCardsController } from '../giftcards/giftcards.controller';
import { KycController } from '../kyc/kyc.controller';

function ctx(paused: boolean) {
  const handler = () => undefined;
  if (paused) Reflect.defineMetadata(PAUSED_IN_MAINTENANCE, true, handler);
  return { getHandler: () => handler, getClass: () => class {} } as never;
}
function guard(setting: { maintenanceMode: boolean; maintenanceMessage: string | null } | null) {
  const prisma = { siteSetting: { findUnique: jest.fn(async () => setting) } };
  let now = 0;
  const g = new MaintenanceGuard(new Reflector(), prisma as never, () => now);
  return { g, prisma, advance: (ms: number) => (now += ms) };
}

describe('MaintenanceGuard (FLUTTER_API Appendix F #15)', () => {
  it('lets every route through while maintenance is off', async () => {
    expect(await guard({ maintenanceMode: false, maintenanceMessage: null }).g.canActivate(ctx(true))).toBe(true);
  });

  it('refuses a money-moving route with 503, code MAINTENANCE and the admin message', async () => {
    const err = await guard({ maintenanceMode: true, maintenanceMessage: 'Back by 2pm.' }).g.canActivate(ctx(true)).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.getResponse()).toEqual({ statusCode: 503, code: 'MAINTENANCE', message: 'Back by 2pm.' });
  });

  it('uses a plain default message when the admin left none', async () => {
    const err = await guard({ maintenanceMode: true, maintenanceMessage: null }).g.canActivate(ctx(true)).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ message: MAINTENANCE_DEFAULT_MESSAGE });
  });

  it('never blocks unmarked routes (sign-in, balances, history, admin, webhooks), and never reads the setting for them', async () => {
    const { g, prisma } = guard({ maintenanceMode: true, maintenanceMessage: 'x' });
    expect(await g.canActivate(ctx(false))).toBe(true);
    expect(prisma.siteSetting.findUnique).not.toHaveBeenCalled();
  });

  it('no settings row yet means not in maintenance', async () => {
    expect(await guard(null).g.canActivate(ctx(true))).toBe(true);
  });

  it('reads the switch at most every 5 seconds', async () => {
    const { g, prisma, advance } = guard({ maintenanceMode: false, maintenanceMessage: null });
    await g.canActivate(ctx(true));
    await g.canActivate(ctx(true));
    expect(prisma.siteSetting.findUnique).toHaveBeenCalledTimes(1);
    advance(5_001);
    await g.canActivate(ctx(true));
    expect(prisma.siteSetting.findUnique).toHaveBeenCalledTimes(2);
  });

  it('if the setting cannot be read, it fails open (a database blip must not stop every trade by itself)', async () => {
    const prisma = { siteSetting: { findUnique: jest.fn(async () => { throw new Error('db down'); }) } };
    const g = new MaintenanceGuard(new Reflector(), prisma as never, () => 0);
    expect(await g.canActivate(ctx(true))).toBe(true);
  });
});

describe('every money-moving route is paused during maintenance', () => {
  const marked = (ctrl: { prototype: object }, method: string) =>
    Reflect.getMetadata(PAUSED_IN_MAINTENANCE, (ctrl.prototype as Record<string, object>)[method]) === true;

  it.each([
    [QuotesController, 'quote'],
    [QuotesController, 'execute'],
    [WithdrawalsController, 'withdraw'],
    [WithdrawalsController, 'withdrawNgn'],
    [WithdrawalsController, 'verifyNgnBankAccount'],
    [AddressesController, 'create'],
    [VirtualAccountsController, 'open'],
    [GiftCardsController, 'submit'],
    [KycController, 'submitBasic'],
  ] as const)('%p.%s', (ctrl, method) => {
    expect((ctrl.prototype as unknown as Record<string, unknown>)[method]).toBeDefined();
    expect(marked(ctrl, method)).toBe(true);
  });
});
