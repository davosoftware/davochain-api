import 'reflect-metadata';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { WithdrawalsService } from './withdrawals.service';
import { WithdrawCryptoDto, WithdrawNgnDto } from './dto';
import { dec } from '../common/money';

const NOW = new Date('2026-10-15T10:00:00Z');
const BANK_ROW = { id: 'b1', userId: 'u1', bankCode: '044', bankName: 'Access Bank', accountNumber: '0123456789', accountName: 'ADA', usableFrom: new Date('2026-10-15T09:00:00Z'), removedAt: null };
const ADDR_ROW = { id: 'c1', userId: 'u1', assetCode: 'btc', networkId: 'btc', address: 'bc1qxyz12345678', destinationTag: null, usableFrom: new Date('2026-10-15T09:00:00Z'), removedAt: null };

/** The saved-destination layer only: the money code behind it is stubbed. */
function routed(rows: { bank?: Record<string, unknown> | null; crypto?: Record<string, unknown> | null }) {
  const svc = Object.create(WithdrawalsService.prototype) as WithdrawalsService & Record<string, jest.Mock>;
  const prisma = {
    savedBankAccount: { findFirst: jest.fn(async ({ where }: { where: { id: string; userId: string } }) => (rows.bank && rows.bank.id === where.id && rows.bank.userId === where.userId && !rows.bank.removedAt ? rows.bank : null)) },
    savedCryptoAddress: { findFirst: jest.fn(async ({ where }: { where: { id: string; userId: string } }) => (rows.crypto && rows.crypto.id === where.id && rows.crypto.userId === where.userId && !rows.crypto.removedAt ? rows.crypto : null)) },
  };
  Object.assign(svc, { prisma, withdrawNgn: jest.fn(async () => ({ status: 'PROCESSING' })), withdrawCrypto: jest.fn(async () => ({ status: 'PROCESSING' })) });
  return svc;
}

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'setTimeout'] }));
afterEach(() => jest.useRealTimers());

describe('Withdrawals go only to a saved destination (C6)', () => {
  it('someone else\'s or a removed bank account is not found; nothing is sent', async () => {
    const svc = routed({ bank: { ...BANK_ROW, userId: 'u2' } });
    await expect(svc.withdrawNgnToSaved('u1', { amount: '5000', savedBankAccountId: 'b1' })).rejects.toThrow(new NotFoundException('Saved account not found'));
    const removed = routed({ bank: { ...BANK_ROW, removedAt: NOW } });
    await expect(removed.withdrawNgnToSaved('u1', { amount: '5000', savedBankAccountId: 'b1' })).rejects.toThrow(new NotFoundException('Saved account not found'));
    expect(svc.withdrawNgn).not.toHaveBeenCalled();
    const noAddr = routed({});
    await expect(noAddr.withdrawCryptoToSaved('u1', { amount: '0.01', savedCryptoAddressId: 'c9' })).rejects.toThrow(new NotFoundException('Saved address not found'));
  });

  it('a destination still in its wait: 403 DESTINATION_COOLING_OFF, saying when (Lagos time)', async () => {
    const svc = routed({ bank: { ...BANK_ROW, usableFrom: new Date('2026-10-16T13:00:00Z') } });
    const err = await svc.withdrawNgnToSaved('u1', { amount: '5000', savedBankAccountId: 'b1' }).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ code: 'DESTINATION_COOLING_OFF', until: '2026-10-16T13:00:00.000Z', message: 'This account can be used from 14:00 on 16 October.' });
    const addr = routed({ crypto: { ...ADDR_ROW, usableFrom: new Date('2026-10-16T13:00:00Z') } });
    const e2 = await addr.withdrawCryptoToSaved('u1', { amount: '0.01', savedCryptoAddressId: 'c1' }).catch((e) => e);
    expect(e2.getResponse()).toMatchObject({ message: 'This address can be used from 14:00 on 16 October.' });
  });

  it('a usable bank account: its details go to the payout, with its id', async () => {
    const svc = routed({ bank: BANK_ROW });
    await svc.withdrawNgnToSaved('u1', { amount: '5000', savedBankAccountId: 'b1' });
    expect(svc.withdrawNgn).toHaveBeenCalledWith('u1', { amount: '5000', accountNumber: '0123456789', bankCode: '044' }, 'b1');
  });

  it('a usable address: its coin, network, address and tag go to the send (which re-checks them), with its id', async () => {
    const svc = routed({ crypto: { ...ADDR_ROW, destinationTag: '42' } });
    await svc.withdrawCryptoToSaved('u1', { amount: '0.01', savedCryptoAddressId: 'c1' });
    expect(svc.withdrawCrypto).toHaveBeenCalledWith('u1', { asset: 'btc', network: 'btc', amount: '0.01', address: 'bc1qxyz12345678', destinationTag: '42' }, 'c1');
  });

  it('an old app sending typed bank details or an address is told to choose a saved one', async () => {
    const ngn = await validate(plainToInstance(WithdrawNgnDto, { amount: '5000', accountNumber: '0123456789', bankCode: '044' }));
    expect(ngn.flatMap((e) => Object.values(e.constraints ?? {}))).toContain('Choose a saved bank account');
    const crypto = await validate(plainToInstance(WithdrawCryptoDto, { amount: '1', asset: 'btc', network: 'btc', address: 'x' }));
    expect(crypto.flatMap((e) => Object.values(e.constraints ?? {}))).toContain('Choose a saved address');
    expect(await validate(plainToInstance(WithdrawNgnDto, { amount: '5000', savedBankAccountId: 'b1' }))).toHaveLength(0);
  });
});

describe('The withdrawal records which saved destination it used', () => {
  it('naira: savedBankAccountId is written on the transaction', async () => {
    const created: Array<Record<string, unknown>> = [];
    const stop = new Error('stop after the create');
    const t = {
      user: { findUnique: jest.fn(async () => ({ kycTier: 'TIER_1' })) },
      transaction: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => (created.push(data), { id: 'tx1' })) },
      settlementLeg: { create: jest.fn(async () => { throw stop; }) },
    };
    const allowed = { allowed: true, singleLimit: dec(200000), dailyLimit: dec(500000), usedToday: dec(0), remainingToday: dec(500000), currency: 'NGN' };
    const svc = new WithdrawalsService(
      { user: { findUnique: jest.fn(async () => ({ id: 'u1', kycTier: 'TIER_1', createdAt: new Date(0), credentialsChangedAt: null })) }, serializable: jest.fn((fn: (x: unknown) => unknown) => fn(t)) } as never,
      { verifyBankAccount: jest.fn(async () => ({ account_name: 'ADA' })), fetchBanks: jest.fn(async () => [{ code: '044', name: 'Access Bank', country: 'Nigeria', currency: 'NGN' }]), newReference: () => 'ref' } as never,
      { lock: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      { resolve: jest.fn(async () => null) } as never,
      { check: jest.fn(async () => allowed), checkInTransaction: jest.fn(async () => allowed), fx: async () => ({ ngnPerUsd: '1500' }) } as never,
      { assertNgnWithdrawalsAllowed: jest.fn(), assertWithdrawalsAllowed: jest.fn(), assertNgnWithdrawalsAllowedIn: jest.fn(), ngnWithdrawalsEnabled: jest.fn(async () => true) } as never,
      { notify: jest.fn() } as never,
      { assertCooledOff: async () => undefined } as never,
    );
    await expect(svc.withdrawNgn('u1', { amount: '5000', accountNumber: '0123456789', bankCode: '044' }, 'b1')).rejects.toBe(stop);
    expect(created[0]).toMatchObject({ savedBankAccountId: 'b1', payoutAccountLast4: '6789' });
  });
});
