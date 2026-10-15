import { SettlementService } from './settlement.service';
import { QuidaxError, QuidaxRateLimitError, QuidaxUnknownError } from '../quidax/quidax.errors';

/**
 * M5 (PROJECT_REVIEW): the reason shown to a customer (in an error, a refund
 * message, and their transaction history) came straight from Quidax or from
 * our own internals, database errors included. Customers now only ever see a
 * fixed set of plain messages; the raw detail is kept for staff.
 */
const svc = () => {
  const s = Object.create(SettlementService.prototype) as SettlementService;
  return s;
};
const PUBLIC = [
  'Outcome unknown — awaiting confirmation',
  'The service is busy. Please try again in a moment',
  'The rate changed before we could complete this. Please try again',
  'This amount is below the minimum allowed',
  'This could not be completed right now. Please try again shortly',
  'Our provider could not complete this request',
  'Something went wrong on our side',
];

describe('M5: customers only see plain, fixed reasons', () => {
  it.each([
    ['a database error', new Error('Invalid `prisma.transaction.update()` invocation: connection terminated'), 'Something went wrong on our side'],
    ['a Quidax business error', new QuidaxError('Wallet 0xabc locked by compliance rule 7', 'E0042', 422), 'Our provider could not complete this request'],
    ['an expired Quidax quotation', new QuidaxError('quotation has expired', 'E0107', 422), 'The rate changed before we could complete this. Please try again'],
    ['an amount below the minimum', new QuidaxError('amount is less than minimum withdrawable', null, 422), 'This amount is below the minimum allowed'],
    ['a Quidax balance problem (never reveals whose)', new QuidaxError('Insufficient balance in main account', null, 422), 'This could not be completed right now. Please try again shortly'],
    ['a rate-limit refusal', new QuidaxRateLimitError(429, 1000), 'The service is busy. Please try again in a moment'],
    ['an unknown outcome', new QuidaxUnknownError('socket hang up', 'POST', '/x'), 'Outcome unknown — awaiting confirmation'],
  ])('%s', (_name, err, expected) => {
    expect(svc().describe(err)).toBe(expected);
  });

  it('nothing outside the fixed set ever comes out', () => {
    for (const e of [new Error('x'), 'a string', null, new QuidaxError('<script>', null, 400)]) {
      expect(PUBLIC).toContain(svc().describe(e));
    }
  });

  it('staff still get the full detail', () => {
    expect(svc().internalReason(new Error('connection terminated'))).toBe('connection terminated');
    expect(svc().internalReason(new QuidaxError('Wallet locked', 'E0042', 422))).toBe('Quidax 422 E0042: Wallet locked');
  });
});
