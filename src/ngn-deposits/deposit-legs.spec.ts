import { dec } from '../common/money';
import type { LedgerLeg } from '../ledger/ledger.service';
import { DepositLegsError, depositBalances, depositLegs } from './deposit-legs';

/** Debits minus credits, the ledger's own balance rule. */
const net = (legs: LedgerLeg[]) =>
  legs.reduce((sum, l) => (l.direction === 'DEBIT' ? sum.plus(dec(l.amount)) : sum.minus(dec(l.amount))), dec(0));

describe('depositLegs', () => {
  it('credits the user the full amount and books what Flutterwave kept as our fee', () => {
    const legs = depositLegs({ userId: 'u1', amount: dec('1500'), settled: dec('1479'), fee: dec('21'), memo: 'm' });
    expect(legs).toEqual([
      { account: 'USER', userId: 'u1', assetCode: 'ngn', direction: 'CREDIT', amount: '1500', memo: 'm' },
      { account: 'EXTERNAL', assetCode: 'ngn', direction: 'DEBIT', amount: '1479', memo: 'm' },
      { account: 'PROVIDER_FEE', assetCode: 'ngn', direction: 'DEBIT', amount: '21', memo: 'm' },
    ]);
    expect(net(legs).isZero()).toBe(true);
  });

  it('keeps kobo exact', () => {
    const legs = depositLegs({ userId: 'u1', amount: dec('1500.50'), settled: dec('1479.49'), fee: dec('21.01'), memo: 'm' });
    expect(legs.map((l) => l.amount)).toEqual(['1500.5', '1479.49', '21.01']);
    expect(net(legs).isZero()).toBe(true);
  });

  it('leaves out a zero fee leg', () => {
    const legs = depositLegs({ userId: 'u1', amount: dec('1500'), settled: dec('1500'), fee: dec('0'), memo: 'm' });
    expect(legs.map((l) => l.account)).toEqual(['USER', 'EXTERNAL']);
  });

  it('refuses a deposit that does not balance', () => {
    expect(() => depositLegs({ userId: 'u1', amount: dec('1500'), settled: dec('1479'), fee: dec('25'), memo: 'm' })).toThrow(DepositLegsError);
    expect(depositBalances(dec('1500'), dec('1479'), dec('25'))).toBe(false);
    expect(depositBalances(dec('1500'), dec('1479'), dec('21'))).toBe(true);
    expect(depositBalances(dec('1500'), null, dec('21'))).toBe(false);
  });

  it('refuses a non-positive amount or a negative part', () => {
    expect(() => depositLegs({ userId: 'u1', amount: dec('0'), settled: dec('0'), fee: dec('0'), memo: 'm' })).toThrow(DepositLegsError);
    expect(() => depositLegs({ userId: 'u1', amount: dec('10'), settled: dec('11'), fee: dec('-1'), memo: 'm' })).toThrow(DepositLegsError);
  });
});
