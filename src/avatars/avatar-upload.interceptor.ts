import { BadRequestException, CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor, PayloadTooLargeException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Observable, catchError, from, mergeMap, throwError } from 'rxjs';
import { AVATAR_MAX_BYTES } from './avatar-image';

/** multer, in memory, held to one photo and nothing else. */
const Multipart = FileInterceptor('file', { limits: { fileSize: AVATAR_MAX_BYTES, files: 1, fields: 0, parts: 1 } });

const notMultipart = () =>
  new BadRequestException({ code: 'AVATAR_NOT_MULTIPART', message: 'Send the photo as multipart/form-data with one field: "file".' });

const hasCode = (err: unknown): boolean => {
  const body = err instanceof HttpException ? err.getResponse() : null;
  return typeof body === 'object' && body !== null && 'code' in body;
};

/** Reads the one uploaded photo (29 Oct 2026). Anything but multipart is refused in plain words. */
@Injectable()
export class AvatarUploadInterceptor implements NestInterceptor {
  private readonly multipart = new Multipart();

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<{ is(type: string): string | false | null }>();
    if (!req.is('multipart/form-data')) throw notMultipart();
    return from(this.multipart.intercept(ctx, next)).pipe(
      mergeMap((inner) => inner),
      // Multer's own refusals carry no code (and their wording changes between
      // releases); ours from the service do, and pass through untouched.
      catchError((err) =>
        throwError(() =>
          hasCode(err)
            ? err
            : err instanceof PayloadTooLargeException
              ? new PayloadTooLargeException({ code: 'AVATAR_TOO_LARGE', message: 'Your photo must be 5 MB or smaller.' })
              : err instanceof BadRequestException
                ? notMultipart()
                : err,
        ),
      ),
    );
  }
}
