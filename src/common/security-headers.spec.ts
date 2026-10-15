import { securityHeaders } from './security-headers';

/**
 * M7 (PROJECT_REVIEW): the API switched off its Content-Security-Policy for
 * every route, only because the Swagger page at /docs needs inline scripts.
 * Now only /docs runs without it.
 */
function call(path: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: (k: string, v: string) => (headers[k.toLowerCase()] = String(v)),
    removeHeader: (k: string) => delete headers[k.toLowerCase()],
    getHeader: (k: string) => headers[k.toLowerCase()],
  };
  return new Promise((resolve) => securityHeaders()({ path, url: path, method: 'GET', headers: {} } as never, res as never, () => resolve(headers)));
}

describe('M7: the API sends a Content-Security-Policy', () => {
  it('on API routes', async () => {
    const h = await call('/v1/quotes');
    expect(h['content-security-policy']).toContain("default-src 'self'");
    expect(h['content-security-policy']).toContain("frame-ancestors 'self'");
  });

  it('not on the Swagger page, which needs inline scripts', async () => {
    expect((await call('/docs'))['content-security-policy']).toBeUndefined();
    expect((await call('/docs/swagger-ui.css'))['content-security-policy']).toBeUndefined();
  });

  it('the other helmet headers stay everywhere', async () => {
    expect((await call('/docs'))['x-content-type-options']).toBe('nosniff');
    expect((await call('/v1/me'))['x-content-type-options']).toBe('nosniff');
  });
});
