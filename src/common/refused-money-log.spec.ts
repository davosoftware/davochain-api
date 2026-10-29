import { describeRefusal } from './refused-money-log';

/**
 * A send, withdrawal or trade refused before anything was recorded (a missing
 * PIN header, a missing Idempotency-Key) left no trace anywhere (29 Oct 2026).
 * One log line now says what was refused and why, never the PIN itself.
 */
const base = {
  method: 'POST',
  path: '/v1/transfers/crypto',
  status: 403,
  headers: { 'idempotency-key': 'k1', 'content-type': 'application/json' } as Record<string, string | undefined>,
  body: { statusCode: 403, code: 'PIN_REQUIRED', message: 'Enter your transaction PIN.' },
  userId: 'u-joshua',
};

describe('describeRefusal', () => {
  it('names the route, status, code, customer and which headers came', () => {
    expect(describeRefusal(base)).toBe(
      'Refused POST /v1/transfers/crypto → 403 PIN_REQUIRED "Enter your transaction PIN." user=u-joshua pinHeader=no idempotencyKey=yes contentType=application/json',
    );
  });

  it('never prints the PIN, only that it came', () => {
    const line = describeRefusal({ ...base, headers: { ...base.headers, 'x-transaction-pin': '4826' } })!;
    expect(line).toContain('pinHeader=yes');
    expect(line).not.toContain('4826');
  });

  it('covers withdrawals and trades; a missing Idempotency-Key shows', () => {
    const line = describeRefusal({
      ...base,
      path: '/v1/withdrawals/ngn',
      status: 400,
      headers: {},
      body: { statusCode: 400, message: 'Idempotency-Key header is required for this request' },
    })!;
    expect(line).toContain('→ 400 "Idempotency-Key header is required for this request"');
    expect(line).toContain('idempotencyKey=no contentType=none');
    expect(describeRefusal({ ...base, path: '/v1/trades' })).not.toBeNull();
  });

  it('a validation list is joined; a missing sign-in says so', () => {
    const line = describeRefusal({ ...base, status: 400, userId: null, body: { statusCode: 400, message: ['amount must be a string', 'username must be a string'] } })!;
    expect(line).toContain('"amount must be a string; username must be a string" user=not signed in');
  });

  it('stays quiet on success, on reads and on other routes', () => {
    expect(describeRefusal({ ...base, status: 201 })).toBeNull();
    expect(describeRefusal({ ...base, method: 'GET', path: '/v1/transfers/recipient' })).toBeNull();
    expect(describeRefusal({ ...base, path: '/v1/auth/login' })).toBeNull();
  });
});
