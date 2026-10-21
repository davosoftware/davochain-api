import { classifyHttp, classifyTransportError } from './dojah.classify';

describe('classifyHttp (plan §R1.2)', () => {
  it.each([
    [400, 'BAD_REQUEST'],
    [401, 'AUTH'],
    [402, 'WALLET'],
    [403, 'IP'],
    [429, 'RATE_LIMITED'],
    [500, 'SERVER'],
    [502, 'SERVER'],
    [503, 'SERVER'],
  ])('%i is DEFINITELY_FAILED as %s', (status, kind) => {
    const r = classifyHttp(status, { error: 'x' }, 'lookup');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe(kind);
      expect(r.error.definitelyFailed).toBe(true);
    }
  });

  it('404 on a lookup is an answer: the number does not exist', () => {
    expect(classifyHttp(404, { error: 'Invalid BVN' }, 'lookup')).toEqual({ ok: true, notFound: true });
  });

  it('404 on AML or balance is our mistake (wrong path), a definite failure', () => {
    const r = classifyHttp(404, { error: 'Page Not Found' }, 'aml');
    expect(r.ok === false && r.error.kind).toBe('BAD_REQUEST');
  });

  it('200 with a body is a success', () => {
    expect(classifyHttp(200, { entity: {} }, 'aml')).toEqual({ ok: true, body: { entity: {} } });
  });

  it('200 with no readable body is UNKNOWN: Dojah did the work and we cannot read it', () => {
    const r = classifyHttp(200, undefined, 'aml');
    expect(r.ok === false && r.error.kind).toBe('UNKNOWN');
    expect(r.ok === false && r.error.definitelyFailed).toBe(false);
  });

  it('never puts an 11-digit number in a message', () => {
    const r = classifyHttp(400, { error: 'bad bvn 22222222222' }, 'lookup');
    expect(r.ok === false && r.error.message).not.toContain('22222222222');
  });

  it('never names the IP address from a 403', () => {
    const r = classifyHttp(403, { error: 'Requests from IP 102.90.124.188 are not allowed' }, 'lookup');
    expect(r.ok === false && r.error.message).not.toContain('102.90');
  });
});

describe('classifyTransportError (plan §R1.2)', () => {
  const e = (code: string, name = 'Error') => Object.assign(new Error(code), { code, name });

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'])('%s never left: NOT_SENT', (code) => {
    const r = classifyTransportError(e(code));
    expect(r.kind).toBe('NOT_SENT');
    expect(r.definitelyFailed).toBe(true);
  });

  it.each(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'ECONNRESET', 'SOMETHING_NEW'])(
    '%s may have been performed: UNKNOWN',
    (code) => expect(classifyTransportError(e(code)).kind).toBe('UNKNOWN'),
  );

  it('our own deadline (AbortSignal.timeout) is UNKNOWN', () => {
    expect(classifyTransportError(Object.assign(new Error('aborted'), { name: 'TimeoutError' })).kind).toBe('UNKNOWN');
  });

  it('undici wraps the cause: a refused connection inside a cause is still NOT_SENT', () => {
    expect(classifyTransportError(Object.assign(new Error('fetch failed'), { cause: e('ECONNREFUSED') })).kind).toBe('NOT_SENT');
  });
});

describe('classifyHttp for documents (Advanced)', () => {
  it('reads 424 as a document Dojah could not process (definitely failed)', () => {
    const v = classifyHttp(424, { error: 'Unable to process' }, 'readId');
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.error.kind).toBe('UNPROCESSABLE');
      expect(v.error.definitelyFailed).toBe(true);
    }
  });
});
