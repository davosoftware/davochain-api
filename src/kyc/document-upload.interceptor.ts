import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Observable, catchError, from, mergeMap, throwError } from 'rxjs';
import { MAX_DOCUMENT_BYTES } from './kyc-documents.service';

/** multer (in memory: no storage option means memory), held to one small file and a handful of tiny fields. */
const Multipart = FileInterceptor('file', {
  limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1, fields: 5, fieldSize: 1024, parts: 7 },
});

/**
 * Reads the one uploaded document (H8).
 *
 * The old JSON body carried a storage location chosen by the app: refused
 * with a message saying what to send instead. A file over the limit is a 413
 * in plain words, before any of it reaches the service.
 */
@Injectable()
export class DocumentUploadInterceptor implements NestInterceptor {
  private readonly multipart = new Multipart();

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<{ is(type: string): string | false | null }>();
    if (!req.is('multipart/form-data')) {
      throw new BadRequestException(
        'Send the document as multipart/form-data with two fields: "type" and "file". A storage location is no longer accepted.',
      );
    }
    return from(this.multipart.intercept(ctx, next)).pipe(
      mergeMap((inner) => inner),
      catchError((err) =>
        throwError(() =>
          err instanceof PayloadTooLargeException ? new PayloadTooLargeException('Each document must be 10 MB or smaller') : err,
        ),
      ),
    );
  }
}
