import { dec } from '../common/money';
import { PayrepMock } from '../payrep/payrep.mock';
import { RailRefusedError, RailUnknownError } from './naira-rail';
import { PayrepRail } from './payrep-rail';

describe('PayrepRail (spec §5)', () => {
  let payrep: PayrepMock;
  let alerts: { raise: jest.Mock };
  let rail: PayrepRail;
  const input = (amount: string, reference = `dvc_ngnwd_${amount}`) => ({ reference, bankCode: '000014', accountNumber: '0123456789', amount: dec(amount), narration: 'DavoChain payout' });

  beforeEach(() => {
    payrep = new PayrepMock({ port: 1 });
    alerts = { raise: jest.fn().mockResolvedValue(true) };
    rail = new PayrepRail(payrep, { mainAccount: '7801234567' } as never, alerts as never);
  });

  it('a sent transfer is PENDING; it finishes only through Transaction Status', async () => {
    expect(await rail.transfer(input('100.00'))).toMatchObject({ reference: 'dvc_ngnwd_100.00', status: 'PENDING' });
    expect(await rail.transferStatus('dvc_ngnwd_100.00')).toMatchObject({ reference: 'dvc_ngnwd_100.00', status: 'SUCCESSFUL', reason: null });
  });

  it('sends the checked name, the main account name, and 2-decimal naira', async () => {
    const spy = jest.spyOn(payrep, 'transfer');
    await rail.transfer(input('2500.5'));
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ sourceAccountNumber: '7801234567', sourceAccountName: 'DAVOCHAIN MOCK MAIN', beneficiaryAccountName: 'MOCK ACCOUNT 6789', bankCode: '000014', amount: '2500.50', transferType: 'inter' }),
    );
  });

  it('a failed transfer reports FAILED with a reason', async () => {
    await rail.transfer(input('7.13', 'bad'));
    expect(await rail.transferStatus('bad')).toMatchObject({ status: 'FAILED', reason: expect.stringMatching(/failed/) });
  });

  it('only a clear no is RailRefusedError: 51, and a bad account at name enquiry (nothing sent)', async () => {
    await expect(rail.transfer(input('5.51'))).rejects.toBeInstanceOf(RailRefusedError);
    const spy = jest.spyOn(payrep, 'transfer');
    await expect(rail.transfer({ ...input('5.00'), accountNumber: '0123450000' })).rejects.toBeInstanceOf(RailRefusedError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('duplicate, unavailable and lost answers are RailUnknownError: never refunded', async () => {
    for (const a of ['5.80', '5.99']) await expect(rail.transfer(input(a))).rejects.toBeInstanceOf(RailUnknownError);
    await rail.transfer(input('6.00', 'same'));
    await expect(rail.transfer(input('6.00', 'same'))).rejects.toBeInstanceOf(RailUnknownError);
  });

  it('maker-checker (Review Focus 1): RailUnknownError, and owners are alerted', async () => {
    await expect(rail.transfer(input('5.77'))).rejects.toBeInstanceOf(RailUnknownError);
    expect(alerts.raise).toHaveBeenCalledWith('NAIRA_RAIL_CONFIG', 'maker-checker', expect.stringMatching(/approval/), expect.any(Array), expect.any(Number));
  });

  it('transferStatus: null only for "not found"; "unavailable" throws', async () => {
    expect(await rail.transferStatus('never-sent')).toBeNull();
    await rail.transfer(input('3.98', 'flaky'));
    await expect(rail.transferStatus('flaky')).rejects.toBeInstanceOf(RailUnknownError);
  });

  it('balance and banks', async () => {
    expect((await rail.balance()).available.toFixed()).toBe('50000000');
    expect(await rail.banks()).toEqual(expect.arrayContaining([{ code: '000014', name: 'Access Bank' }]));
    expect(await rail.resolveAccount({ bankCode: '000014', accountNumber: '0123456789' })).toEqual({ accountName: 'MOCK ACCOUNT 6789' });
    await expect(rail.resolveAccount({ bankCode: '000014', accountNumber: '0123450000' })).rejects.toBeInstanceOf(RailRefusedError);
  });

  it('the main account must be set', async () => {
    const bare = new PayrepRail(new PayrepMock({ port: 1 }), { mainAccount: null } as never, alerts as never);
    await expect(bare.transfer(input('5.00'))).rejects.toBeInstanceOf(RailRefusedError);
  });
});
