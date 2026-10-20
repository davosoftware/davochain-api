import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { QuidaxRateLimitError } from '../quidax/quidax.errors';

/**
 * M9: Quidax said "too many requests", or our shared Quidax budget would have
 * made the call wait longer than its lane allows. Nothing was done upstream,
 * so the honest answer is "busy, try again", not "Internal server error".
 */
@Catch(QuidaxRateLimitError)
export class QuidaxBusyFilter implements ExceptionFilter {
  catch(err: QuidaxRateLimitError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    res.setHeader('retry-after', String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))));
    res.status(503).json({ statusCode: 503, code: 'BUSY', message: 'The service is busy. Please try again in a moment.' });
  }
}
