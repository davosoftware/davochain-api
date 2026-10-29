import { Logger } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Sends, withdrawals and trades: the requests that move money. */
const MONEY_ROUTE = /^\/v1\/(transfers\/crypto|withdrawals\/|trades\b)/;

/**
 * One line for a money request that was refused (29 Oct 2026). A refusal by
 * a guard (no PIN header, wrong level) or for a missing Idempotency-Key
 * happens before anything is recorded, so without this there was no trace of
 * it anywhere. Says which headers came, never their values: never the PIN.
 */
export function describeRefusal(r: {
  method: string;
  path: string;
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  userId: string | null;
}): string | null {
  if (r.method !== 'POST' || r.status < 400 || !MONEY_ROUTE.test(r.path)) return null;
  const body = (r.body ?? {}) as { code?: unknown; message?: unknown };
  const message = Array.isArray(body.message) ? body.message.join('; ') : typeof body.message === 'string' ? body.message : '';
  const code = typeof body.code === 'string' ? ` ${body.code}` : '';
  const has = (name: string) => (r.headers[name] ? 'yes' : 'no');
  const contentType = String(r.headers['content-type'] ?? 'none').split(';')[0];
  return (
    `Refused ${r.method} ${r.path} → ${r.status}${code}${message ? ` "${message.slice(0, 200)}"` : ''}` +
    ` user=${r.userId ?? 'not signed in'} pinHeader=${has('x-transaction-pin')} idempotencyKey=${has('idempotency-key')}` +
    ` contentType=${contentType}`
  );
}

export function refusedMoneyLog(): RequestHandler {
  const log = new Logger('RefusedMoneyRequest');
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'POST' || !MONEY_ROUTE.test(req.path)) return next();
    // The reply body, to say why; only kept for this request.
    let sent: unknown;
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      sent = body;
      return json(body);
    };
    res.on('finish', () => {
      const line = describeRefusal({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        headers: req.headers,
        body: sent,
        userId: (req as Request & { user?: { sub?: string } }).user?.sub ?? null,
      });
      if (line) log.warn(line);
    });
    next();
  };
}
