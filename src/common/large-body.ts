import express from 'express';
import type { NextFunction, Request, Response } from 'express';

/**
 * Five 5 MB photos as base64 data URLs come to about 33.4 MB, plus the rest
 * of the JSON. 36 MB covers it; Nginx must allow the same on this route
 * (Reports/HOW_DAVOCHAIN_WORKS.md, Nginx section).
 */
export const LARGE_BODY_BYTES = 36 * 1024 * 1024;

/** Routes whose body may be larger than the normal 1 MB. Method + path after the prefix. */
const ROUTES: { method: string; path: string }[] = [{ method: 'POST', path: 'giftcards/trades' }];

/**
 * The gift-card sale's own body reader, registered BEFORE the global 1 MB
 * parser in main.ts (Express's JSON parser skips a body already read).
 *
 * Reading 36 MB costs memory, so the sign-in token is checked first: a
 * request without a valid one is refused before a single byte of its body is
 * read. The normal guards (user, maintenance, level, rate limit) still run
 * afterwards on the route itself.
 */
export function registerLargeBodyRoutes(
  app: { use: (fn: (req: Request, res: Response, next: NextFunction) => void) => unknown },
  opts: { prefix: string; verify: (token: string) => Promise<boolean> },
): void {
  const parse = express.json({ limit: LARGE_BODY_BYTES });
  const paths = new Set(ROUTES.map((r) => `${r.method} /${opts.prefix}/${r.path}`));

  app.use(function largeBodyRoutes(req: Request, res: Response, next: NextFunction) {
    if (!paths.has(`${req.method} ${req.path}`)) return next();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    const refuse = () => {
      res.setHeader('connection', 'close');
      res.status(401).json({ statusCode: 401, message: 'Invalid or expired token' });
    };
    if (scheme?.toLowerCase() !== 'bearer' || !token) return refuse();
    opts
      .verify(token)
      .then((valid) => {
        if (!valid) return refuse();
        parse(req, res, (err?: unknown) => {
          const e = err as { type?: string; status?: number } | undefined;
          if (e?.type === 'entity.too.large') {
            res.setHeader('connection', 'close');
            res.status(413).json({ statusCode: 413, message: 'This request is too large. A card can have up to 5 photos of 5 MB each.' });
            return;
          }
          next(err);
        });
      })
      .catch(() => refuse());
  });
}
