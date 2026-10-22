import { classifyCreateAccount, classifyRead, classifyStatus, classifyTransfer } from './payrep.classify';

const ok = (data: unknown, message = 'ok') => ({ status: true, response_code: '00', message, data });
const no = (code: string, message: string) => ({ status: false, response_code: code, message, data: null });

describe('classifyTransfer (spec §2.1)', () => {
  it('successful and pending are SENT; the rail still finishes through Transaction Status', () => {
    expect(classifyTransfer(200, ok({ id: 't1', status: 'successful', charges: '10.75' }))).toEqual({ kind: 'SENT', id: 't1', providerStatus: 'successful', fee: '10.75' });
    expect(classifyTransfer(200, ok({ id: 't2', status: 'pending', charges: null }))).toMatchObject({ kind: 'SENT', providerStatus: 'pending', fee: null });
  });
  it('maker-checker: "completed once it has been approved" is QUEUED, never SENT', () => {
    expect(
      classifyTransfer(200, { status: true, response_code: '00', message: 'This transaction will be completed once it has been approved', data: { auth_request_id: 'a1' } }),
    ).toEqual({ kind: 'QUEUED_FOR_APPROVAL' });
    expect(classifyTransfer(200, ok({ auth_request_id: 'a2' }))).toEqual({ kind: 'QUEUED_FOR_APPROVAL' });
  });
  it('code 51 is the only coded refusal', () => expect(classifyTransfer(200, no('51', 'Insufficient balance'))).toEqual({ kind: 'REFUSED', reason: 'Insufficient balance' }));
  // The sandbox (22 Oct 2026) answers HTTP 400 with code 83 for BOTH of these: only the words tell them apart.
  it('sandbox: HTTP 400 code 83 "Insufficient balance" is a refusal', () =>
    expect(classifyTransfer(400, no('83', 'Insufficient balance'))).toEqual({ kind: 'REFUSED', reason: 'Insufficient balance' }));
  it('sandbox: HTTP 400 code 83 "Duplicate transaction…" stays UNCLEAR (it may have been paid)', () =>
    expect(classifyTransfer(400, no('83', 'Duplicate transaction. This reference number has already been processed.')).kind).toBe('UNCLEAR'));
  it('sandbox: HTTP 500 code "error" is UNCLEAR', () => expect(classifyTransfer(500, { message: "[<class 'decimal.ConversionSyntax'>]", response_code: 'error', data: null }).kind).toBe('UNCLEAR'));
  it('sandbox: a successful send reads as SENT', () =>
    expect(classifyTransfer(200, ok({ id: 'a1b2', status: 'successful', charges: '0', amount: '1.00' }, 'Transfer successful (Sandbox)'))).toEqual({ kind: 'SENT', id: 'a1b2', providerStatus: 'successful', fee: '0' }));
  it('HTTP 400 "invalid" is a refusal (no transaction is created)', () => {
    expect(classifyTransfer(400, { message: 'beneficiary_account_number: must be 10 digits', response_code: 'invalid', data: null })).toMatchObject({ kind: 'REFUSED' });
  });
  it.each([
    ['duplicate reference', 200, no('80', 'Duplicate transaction. This reference number has already been processed.')],
    ['service unavailable', 200, no('80', 'Service unavailable')],
    ['source is virtual', 200, no('80', 'Source account cannot be a virtual account')],
    ['duplicate request 50', 200, no('50', 'Duplicate request')],
    ['99', 200, no('99', 'Internal server error')],
    ['429', 429, no('429', 'Request rate limit exceeded')],
    ['500', 500, { message: 'boom' }],
    ['401', 401, { message: 'Unauthorized' }],
    ['unparseable', 200, undefined],
    ['status true, no data', 200, { status: true, response_code: '00', message: 'ok', data: null }],
    ['an unknown data.status', 200, ok({ id: 't', status: 'weird' })],
    ['status false with an unknown code', 200, no('07', 'Something')],
    ['HTTP 400 without "invalid"', 400, no('01', 'Validation error')],
  ])('%s is UNCLEAR: never a refund', (_n, http, body) => expect(classifyTransfer(http as number, body).kind).toBe('UNCLEAR'));
});

describe('classifyStatus (spec §2.2)', () => {
  it('maps the four statuses', () => {
    expect(classifyStatus(200, ok({ transaction_status: 'successful' }))).toEqual({ kind: 'FOUND', status: 'SUCCESSFUL' });
    expect(classifyStatus(200, ok({ transaction_status: 'failed' }))).toEqual({ kind: 'FOUND', status: 'FAILED' });
    expect(classifyStatus(200, ok({ transaction_status: 'pending' }))).toEqual({ kind: 'FOUND', status: 'PENDING' });
    expect(classifyStatus(200, ok({ transaction_status: 'processing' }))).toEqual({ kind: 'FOUND', status: 'PENDING' });
  });
  it('"Transaction not found." exactly is NOT_FOUND', () => expect(classifyStatus(200, no('80', 'Transaction not found.'))).toEqual({ kind: 'NOT_FOUND' }));
  it('anything else is UNCLEAR, including "unavailable" and near-misses of not found', () => {
    expect(classifyStatus(200, no('80', 'Transaction status check unavailable. Please try again later.')).kind).toBe('UNCLEAR');
    expect(classifyStatus(200, no('80', 'Transaction not found')).kind).toBe('NOT_FOUND'); // trailing dot optional
    expect(classifyStatus(200, no('81', 'Transaction not found.')).kind).toBe('UNCLEAR');
    expect(classifyStatus(200, ok({ transaction_status: 'reversed' })).kind).toBe('UNCLEAR');
    expect(classifyStatus(503, undefined).kind).toBe('UNCLEAR');
  });
});

describe('classifyRead', () => {
  it('00 is ok', () => expect(classifyRead(200, ok([1]))).toEqual({ ok: true, data: [1] }));
  it('a token problem asks for a refresh', () => {
    expect(classifyRead(401, { message: 'x' })).toMatchObject({ ok: false, kind: 'TOKEN' });
    expect(classifyRead(200, no('42', 'Token expired or invalid'))).toMatchObject({ ok: false, kind: 'TOKEN' });
  });
  it('42 "Account not found" is a refusal, not a token problem', () => expect(classifyRead(200, no('42', 'Account not found'))).toMatchObject({ ok: false, kind: 'REFUSED' }));
  it('41 / 43 are CONFIG', () => {
    expect(classifyRead(200, no('41', 'Unauthorized - invalid API credentials'))).toMatchObject({ kind: 'CONFIG' });
    expect(classifyRead(200, no('43', 'Insufficient permissions'))).toMatchObject({ kind: 'CONFIG' });
  });
  it('06 / 01 / 02 / 400 invalid are refusals; 80 / 99 / 429 / 5xx unclear', () => {
    expect(classifyRead(200, no('06', 'Account not found.'))).toMatchObject({ kind: 'REFUSED' });
    expect(classifyRead(400, { response_code: 'invalid', message: 'bank_code: ambiguous' })).toMatchObject({ kind: 'REFUSED' });
    expect(classifyRead(200, no('80', 'Service unavailable'))).toMatchObject({ kind: 'UNCLEAR' });
    expect(classifyRead(200, no('99', 'Internal'))).toMatchObject({ kind: 'UNCLEAR' });
    expect(classifyRead(429, no('429', 'slow down'))).toMatchObject({ kind: 'UNCLEAR' });
    expect(classifyRead(502, undefined)).toMatchObject({ kind: 'UNCLEAR' });
  });
});

describe('classifyCreateAccount (spec §4): a write, so unknown is UNCLEAR', () => {
  it('a full answer is ok', () => expect(classifyCreateAccount(200, ok({ account_number: '2070174481' }))).toEqual({ ok: true, data: { account_number: '2070174481' } }));
  it('83 / 01 / 02 / 400 invalid are refusals', () => {
    expect(classifyCreateAccount(200, no('83', 'Identity verification failed.'))).toMatchObject({ ok: false, kind: 'REFUSED' });
    expect(classifyCreateAccount(200, no('02', 'Either BVN or NIN must be provided.'))).toMatchObject({ kind: 'REFUSED' });
    expect(classifyCreateAccount(400, { response_code: 'invalid', message: 'phone_number: too long' })).toMatchObject({ kind: 'REFUSED' });
  });
  it('"Pool account not found" (42) and 41 / 43 are CONFIG', () => {
    expect(classifyCreateAccount(200, no('42', 'Pool account not found, is a virtual account, or is already linked to another pool'))).toMatchObject({ kind: 'CONFIG' });
    expect(classifyCreateAccount(200, no('43', 'Insufficient permissions'))).toMatchObject({ kind: 'CONFIG' });
  });
  it('50 duplicate, 80, 99, 5xx, unparseable are UNCLEAR', () => {
    const cases: Array<[number, unknown]> = [
      [200, no('50', 'Duplicate request')],
      [200, no('80', 'x')],
      [200, no('99', 'x')],
      [500, undefined],
      [200, undefined],
    ];
    for (const [h, b] of cases) expect(classifyCreateAccount(h, b)).toMatchObject({ kind: 'UNCLEAR' });
  });
});
