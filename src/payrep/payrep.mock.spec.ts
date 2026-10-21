import { PayrepMock } from './payrep.mock';

const m = () => new PayrepMock({ port: 1 });
const t = (amount: string, reference = `ref-${amount}-${Math.random()}`) => ({
  reference,
  sourceAccountNumber: '7801234567',
  sourceAccountName: 'X',
  beneficiaryAccountNumber: '0123456789',
  beneficiaryAccountName: 'Y',
  bankCode: '000014',
  bankName: 'Access Bank',
  amount,
  transferType: 'inter' as const,
  remarks: 'r',
  sessionId: 's',
});

describe('PayrepMock', () => {
  it('transfer scenarios by kobo', async () => {
    const p = m();
    expect((await p.transfer(t('100.00'))).kind).toBe('SENT');
    expect(await p.transfer(t('100.51'))).toMatchObject({ kind: 'REFUSED' });
    expect(await p.transfer(t('100.77'))).toEqual({ kind: 'QUEUED_FOR_APPROVAL' });
    expect((await p.transfer(t('100.99'))).kind).toBe('UNCLEAR');
    expect((await p.transfer(t('100.80'))).kind).toBe('UNCLEAR');
  });
  it('a repeated reference is UNCLEAR (duplicate) and the first still resolves', async () => {
    const p = m();
    await p.transfer(t('5.00', 'dup1'));
    expect((await p.transfer(t('5.00', 'dup1'))).kind).toBe('UNCLEAR');
    expect(await p.transactionStatus('dup1')).toEqual({ kind: 'FOUND', status: 'SUCCESSFUL' });
  });
  it('an unclear transfer that "went through" is found by status; .13 fails; unknown is NOT_FOUND; .98 is always unclear', async () => {
    const p = m();
    await p.transfer(t('100.99', 'lost'));
    expect(await p.transactionStatus('lost')).toEqual({ kind: 'FOUND', status: 'SUCCESSFUL' });
    await p.transfer(t('7.13', 'bad'));
    expect(await p.transactionStatus('bad')).toEqual({ kind: 'FOUND', status: 'FAILED' });
    expect(await p.transactionStatus('nope')).toEqual({ kind: 'NOT_FOUND' });
    await p.transfer(t('3.98', 'flaky'));
    expect((await p.transactionStatus('flaky')).kind).toBe('UNCLEAR');
    await p.transfer(t('100.80', 'busy'));
    expect(await p.transactionStatus('busy')).toEqual({ kind: 'NOT_FOUND' });
  });
  it('banks, name enquiry and the main balance', async () => {
    const p = m();
    expect(await p.banks()).toEqual(expect.arrayContaining([{ name: 'Access Bank', code: '000014', cbnCode: '044' }]));
    expect(await p.nameEnquiry({ accountNumber: '0123456789', bankCode: '000014' })).toMatchObject({ accountName: 'MOCK ACCOUNT 6789', bankName: 'Access Bank', transferType: 'inter' });
    await expect(p.nameEnquiry({ accountNumber: '0123450000', bankCode: '000014' })).rejects.toMatchObject({ kind: 'REFUSED' });
    expect((await p.account('7801234567')).balance).toBe('50000000.00');
  });
  it('customer accounts: stable numbers, 83 and unclear scenarios', async () => {
    const p = m();
    const a = await p.createCustomerAccount({ bvn: '33333333333', poolAccountNumber: '7801234567' });
    expect(a.accountNumber).toMatch(/^20\d{8}$/);
    expect((await m().createCustomerAccount({ bvn: '33333333333', poolAccountNumber: '7801234567' })).accountNumber).toBe(a.accountNumber);
    await expect(p.createCustomerAccount({ bvn: '11111111111', poolAccountNumber: '7801234567' })).rejects.toMatchObject({ kind: 'REFUSED' });
    await expect(p.createCustomerAccount({ nin: '99999999999', poolAccountNumber: '7801234567' })).rejects.toMatchObject({ kind: 'UNCLEAR' });
  });
  it('fetchCredits finds a simulated deposit by account and reference', async () => {
    const p = m();
    const deliver = jest.spyOn(p as unknown as { deliver: () => Promise<number> }, 'deliver').mockResolvedValue(200);
    const { transactionId, webhookStatus } = await p.simulateDeposit({ accountNumber: '2012345678', amount: '5000.00' });
    expect(webhookStatus).toBe(200);
    const day = new Date().toISOString().slice(0, 10);
    const { items } = await p.fetchCredits({ accountNumber: '2012345678', startDate: day, endDate: day });
    expect(items).toEqual([expect.objectContaining({ transactionId, amount: '5000.00', status: 'success', accountNumber: '2012345678', transactionType: 'credit' })]);
    expect((await p.fetchCredits({ accountNumber: '2099999999', startDate: day, endDate: day })).items).toEqual([]);
    expect(await p.redeliver(transactionId)).toBe(200);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(await p.redeliver('nope')).toBeNull();
  });
});
