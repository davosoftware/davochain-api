import type { NextFunction, Request, RequestHandler, Response } from 'express';
import helmet from 'helmet';

/**
 * helmet's headers, Content-Security-Policy included, on every route except
 * the Swagger page (PROJECT_REVIEW M7).
 *
 * Swagger UI loads inline scripts and styles that the default CSP blocks, so
 * the page renders blank. That used to switch CSP off for the whole API; now
 * only /docs runs without it. The API answers JSON, so the default policy
 * costs it nothing and stops a response ever being run as a page or framed.
 */
export function securityHeaders(): RequestHandler {
  const strict = helmet();
  const docs = helmet({ contentSecurityPolicy: false });
  return (req: Request, res: Response, next: NextFunction) =>
    (req.path === '/docs' || req.path.startsWith('/docs/') || req.path.startsWith('/docs-') ? docs : strict)(req, res, next);
}
