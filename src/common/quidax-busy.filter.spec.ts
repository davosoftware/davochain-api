import { QuidaxBusyFilter } from './quidax-busy.filter';
import { QuidaxRateLimitError } from '../quidax/quidax.errors';

/** M9: a Quidax "busy" that reaches a route is a plain 503, never a 500. */
describe('QuidaxBusyFilter', () => {
  function host() {
    const res = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      body: undefined as unknown,
      status(c: number) {
        this.statusCode = c;
        return this;
      },
      setHeader(k: string, v: string) {
        this.headers[k.toLowerCase()] = v;
      },
      json(b: unknown) {
        this.body = b;
      },
    };
    return { res, host: { switchToHttp: () => ({ getResponse: () => res }) } as never };
  }

  it('answers 503 with a plain message and when to try again', () => {
    const { res, host: h } = host();
    new QuidaxBusyFilter().catch(new QuidaxRateLimitError(429, 12_400), h);
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('13');
    expect(res.body).toEqual({ statusCode: 503, code: 'BUSY', message: 'The service is busy. Please try again in a moment.' });
  });

  it('never tells the client to wait less than a second', () => {
    const { res, host: h } = host();
    new QuidaxBusyFilter().catch(new QuidaxRateLimitError(429, 0), h);
    expect(res.headers['retry-after']).toBe('1');
  });
});
