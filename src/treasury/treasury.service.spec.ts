import { AlertType } from '@prisma/client';
import { TreasuryService } from './treasury.service';
import { dec } from '../common/money';

/**
 * Treasury: our naira at the rail and at Quidax against what customers are
 * owed (H4). A figure that can't be read means "can't tell", never ₦0.
 */
function build(o: {
  rail?: string | Error;
  quidax?: string | Error;
  owed?: Array<{ available: string; locked: string }>;
  reserve?: string;
  inFlight?: string;
} = {}) {
  const rail = {
    name: 'Flutterwave',
    balance: jest.fn(async () => {
      if (o.rail instanceof Error) throw o.rail;
      return { available: dec(o.rail ?? '1000000'), ledger: dec(o.rail ?? '1000000') };
    }),
  };
  const settlement = {
    inventory: jest.fn(async () => {
      if (o.quidax instanceof Error) throw o.quidax;
      return dec(o.quidax ?? '500000');
    }),
  };
  const prisma = {
    balance: { findMany: jest.fn(async () => o.owed ?? [{ available: '900000', locked: '100000' }]) },
    treasurySettings: { findUnique: jest.fn(async () => ({ id: 'default', payoutReserveNgn: dec(o.reserve ?? '200000'), quidaxFundingBankCode: null })) },
    transaction: { aggregate: jest.fn(async () => ({ _sum: { toAmount: o.inFlight === undefined ? null : dec(o.inFlight) } })) },
    treasuryMove: { findMany: jest.fn(async () => []) },
  };
  const alerts = { raise: jest.fn(async () => true) };
  const svc = new TreasuryService(prisma as never, rail as never, settlement as never, alerts as never);
  return { svc, alerts, prisma };
}

describe('Treasury: what we hold against what customers are owed', () => {
  it('adds up what customers are owed (available + locked naira)', async () => {
    const s = await build().svc.snapshot();
    expect(s.owed).toBe('1000000');
  });

  it('covered, with the spare amount', async () => {
    const s = await build({ rail: '1000000', quidax: '500000' }).svc.snapshot();
    expect(s).toMatchObject({ covered: 'YES', spare: '500000', shortBy: null, rail: { name: 'Flutterwave', available: '1000000', error: null }, quidaxNgn: '500000' });
  });

  it('short, with how much', async () => {
    const s = await build({ rail: '300000', quidax: '200000' }).svc.snapshot();
    expect(s).toMatchObject({ covered: 'SHORT', shortBy: '500000', spare: null });
  });

  it("a figure that can't be read means can't tell, never short", async () => {
    const s = await build({ rail: new Error('timeout') }).svc.snapshot();
    expect(s).toMatchObject({ covered: 'UNKNOWN', rail: { available: null }, availableToMove: null, spare: null, shortBy: null });
    expect(s.rail.error).toBe("We couldn't read the Flutterwave balance.");
    const q = await build({ quidax: new Error('down') }).svc.snapshot();
    expect(q).toMatchObject({ covered: 'UNKNOWN', quidaxNgn: null });
  });

  it('available to move = rail − payout reserve − customer withdrawals still being sent, never below 0', async () => {
    expect((await build({ rail: '1000000', reserve: '200000', inFlight: '50000' }).svc.snapshot()).availableToMove).toBe('750000');
    expect((await build({ rail: '100000', reserve: '200000' }).svc.snapshot()).availableToMove).toBe('0');
  });
});

describe('The daily Treasury check', () => {
  it('emails owners when we are short', async () => {
    const { svc, alerts } = build({ rail: '300000', quidax: '200000' });
    await svc.dailyCheck();
    expect(alerts.raise).toHaveBeenCalledWith(AlertType.TREASURY_SHORT, 'treasury:short', expect.stringContaining('short by ₦500,000'), expect.any(Array));
  });

  it('emails owners when the rail drops below the payout reserve', async () => {
    const { svc, alerts } = build({ rail: '100000', quidax: '5000000', reserve: '200000' });
    await svc.dailyCheck();
    expect(alerts.raise).toHaveBeenCalledWith(AlertType.TREASURY_RESERVE_LOW, 'treasury:reserve-low', expect.any(String), expect.any(Array));
    expect(alerts.raise).not.toHaveBeenCalledWith(AlertType.TREASURY_SHORT, expect.anything(), expect.anything(), expect.anything());
  });

  it("stays quiet when it can't tell, and when all is well", async () => {
    const unknown = build({ rail: new Error('timeout') });
    await unknown.svc.dailyCheck();
    expect(unknown.alerts.raise).not.toHaveBeenCalled();
    const fine = build();
    await fine.svc.dailyCheck();
    expect(fine.alerts.raise).not.toHaveBeenCalled();
  });
});
