import { classifyResponse } from './flutterwave.classify';
import { FlutterwaveError, FlutterwaveUnknownError } from './flutterwave.errors';

const c = (status: number, body: unknown) => classifyResponse(status, body, 'GET', '/x');
const kind = (v: ReturnType<typeof c>) =>
  v === null
    ? 'SUCCESS'
    : v instanceof FlutterwaveError
      ? v.kind
      : v instanceof FlutterwaveUnknownError
        ? 'UNKNOWN'
        : '?';

describe('classifyResponse', () => {
  it.each([
    [200, { status: 'success', data: {} }, 'SUCCESS'],
    [200, { status: 'error', message: 'odd' }, 'UNKNOWN'],
    [200, undefined, 'UNKNOWN'],
    [400, { status: 'error', message: 'BVN or NIN is required for static account number' }, 'DEFINITE'],
    [400, { status: 'error', message: 'Some error occured', data: 'Error: Insufficient Wallet Balance' }, 'DEFINITE'],
    [400, { status: 'error', message: 'Please enable IP Whitelisting to access this service' }, 'CONFIG'],
    [400, { status: 'error', message: 'Payout with this ref already exists' }, 'ALREADY_EXISTS'],
    [400, { status: 'error', message: 'No transaction was found for this id' }, 'NOT_FOUND'],
    [400, { status: 'error', message: 'Error: Refund Id Not Found' }, 'NOT_FOUND'],
    [401, { status: 'error', message: 'Authorization required' }, 'CONFIG'],
    [403, { status: 'error', message: 'Forbidden' }, 'CONFIG'],
    [404, { status: 'error', message: 'Transfer not found' }, 'NOT_FOUND'],
    [408, { status: 'error', message: 'Request timeout' }, 'UNKNOWN'],
    [429, { status: 'error', message: 'Too many requests' }, 'RATE_LIMITED'],
    [500, { error_id: 'E1', message: 'Application error. Please contact support', code: 'app_error' }, 'UNKNOWN'],
    [503, { status: 'error', message: 'An error occurred. Please contact support', data: null }, 'UNKNOWN'],
    [502, undefined, 'UNKNOWN'],
    [302, { status: 'error' }, 'UNKNOWN'],
  ])('HTTP %s %j → %s', (status, body, expected) => {
    expect(kind(c(status, body))).toBe(expected);
  });

  it('keeps the string detail Flutterwave hides in `data`', () => {
    const err = c(400, { status: 'error', message: 'Some error occured', data: 'Error: Insufficient Wallet Balance' }) as FlutterwaveError;
    expect(err.message).toBe('Some error occured');
    expect(err.detail).toBe('Error: Insufficient Wallet Balance');
    expect(err.httpStatus).toBe(400);
  });

  it('redacts an 11-digit number echoed back in a message or detail', () => {
    const err = c(400, { status: 'error', message: 'BVN 22222223883 is invalid', data: 'bvn 22222223883' }) as FlutterwaveError;
    expect(err.message).not.toContain('22222223883');
    expect(err.detail).not.toContain('22222223883');
  });
});
