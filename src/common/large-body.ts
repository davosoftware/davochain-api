import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Five 5 MB photos as base64 data URLs come to about 33.4 MB, plus the rest
 * of the JSON. 36 MB covers it; Nginx must allow the same on this route
 * (Reports/HOW_DAVOCHAIN_WORKS.md, Nginx section).
 */
export const LARGE_BODY_BYTES = 36 * 1024 * 1024;

/**
 * Admin pictures (C7): a gift-card brand image may be 5 MB, about 6.7 MB as
 * base64. Logos, profile pictures and email images are smaller; one limit
 * covers them all. Nginx must allow the same on these routes.
 */
export const ADMIN_PICTURE_BYTES = 8 * 1024 * 1024;

interface LargeRoute {
  method: string;
  /** The path after the prefix: exact text, or a pattern for a path with a parameter. */
  path: string | RegExp;
  limit: number;
  /** Whose sign-in must be valid before a byte of the body is read. */
  who: 'user' | 'admin';
  tooLarge: string;
}

/** Routes whose body may be larger than the normal 1 MB. */
const ROUTES: LargeRoute[] = [
  { method: 'POST', path: 'giftcards/trades', limit: LARGE_BODY_BYTES, who: 'user', tooLarge: 'This request is too large. A card can have up to 5 photos of 5 MB each.' },
  ...['admin/me/avatar', 'admin/site-settings/logo', 'admin/giftcards/brands', /^admin\/cms\/email-templates\/[^/]+\/image$/].map(
    (path): LargeRoute => ({ method: 'PUT', path, limit: ADMIN_PICTURE_BYTES, who: 'admin', tooLarge: 'This picture is too large. Use one under 5 MB.' }),
  ),
];

/**
 * Larger body readers for the routes above, registered BEFORE the global 1 MB
 * parser in main.ts (Express's JSON parser skips a body already read).
 *
 * Reading megabytes costs memory, so the right sign-in token (a customer's for
 * the gift-card sale, an admin's for admin pictures) is checked first: a
 * request without one is refused before a single byte of its body is read.
 * The normal guards still run afterwards on the route itself.
 */
export function registerLargeBodyRoutes(
  app: { use: (fn: (req: Request, res: Response, next: NextFunction) => void) => unknown },
  opts: { prefix: string; verify: (token: string) => Promise<boolean>; verifyAdmin: (token: string) => Promise<boolean> },
): void {
  const parsers = new Map<number, RequestHandler>();
  const parserFor = (limit: number) => {
    if (!parsers.has(limit)) parsers.set(limit, express.json({ limit }));
    return parsers.get(limit)!;
  };
  const prefix = `/${opts.prefix}/`;
  const match = (req: Request): LargeRoute | undefined => {
    if (!req.path.startsWith(prefix)) return undefined;
    const rest = req.path.slice(prefix.length);
    return ROUTES.find((r) => r.method === req.method && (typeof r.path === 'string' ? r.path === rest : r.path.test(rest)));
  };

  app.use(function largeBodyRoutes(req: Request, res: Response, next: NextFunction) {
    const route = match(req);
    if (!route) return next();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    const refuse = () => {
      res.setHeader('connection', 'close');
      res.status(401).json({ statusCode: 401, message: 'Invalid or expired token' });
    };
    if (scheme?.toLowerCase() !== 'bearer' || !token) return refuse();
    (route.who === 'admin' ? opts.verifyAdmin : opts.verify)(token)
      .then((valid) => {
        if (!valid) return refuse();
        parserFor(route.limit)(req, res, (err?: unknown) => {
          const e = err as { type?: string; status?: number } | undefined;
          if (e?.type === 'entity.too.large') {
            res.setHeader('connection', 'close');
            res.status(413).json({ statusCode: 413, message: route.tooLarge });
            return;
          }
          next(err);
        });
      })
      .catch(() => refuse());
  });
}
