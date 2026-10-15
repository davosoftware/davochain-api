import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Database errors that reach the edge (PROJECT_REVIEW L1).
 *
 * A duplicate (P2002) is the caller's fault: 409. A missing record (P2025) is
 * 404. Anything else is our fault: a plain 500 that says nothing about the
 * database, with the detail in the log. Without this every one of them was a
 * 500, and the specific ones were not distinguishable by the client.
 */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger(PrismaExceptionFilter.name);

  catch(err: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<{ status(code: number): { json(body: unknown): unknown } }>();
    if (err.code === 'P2002') {
      res.status(HttpStatus.CONFLICT).json({ statusCode: HttpStatus.CONFLICT, message: 'That already exists.' });
      return;
    }
    if (err.code === 'P2025') {
      res.status(HttpStatus.NOT_FOUND).json({ statusCode: HttpStatus.NOT_FOUND, message: 'Not found.' });
      return;
    }
    const url = host.switchToHttp().getRequest<{ url?: string }>()?.url ?? '';
    this.log.error(`Database error ${err.code} on ${url}: ${err.message}`);
    res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Something went wrong on our side.' });
  }
}
