import { FlutterwaveError, FlutterwaveUnknownError, redactIds } from './flutterwave.errors';

/**
 * What an HTTP answer from Flutterwave means. Null is success.
 *
 * The one rule: anything we cannot positively identify is UNKNOWN, and UNKNOWN
 * is never a failure — Flutterwave says a timeout "does not always mean request
 * failure", and its gateway answers 5xx after doing the work.
 */
export function classifyResponse(
  httpStatus: number,
  body: unknown,
  method: string,
  path: string,
): FlutterwaveError | FlutterwaveUnknownError | null {
  const obj =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  if (!obj) {
    return new FlutterwaveUnknownError(
      `Flutterwave ${method} ${path} answered HTTP ${httpStatus} without a JSON body`,
      method,
      path,
    );
  }

  const message = redactIds(
    typeof obj.message === 'string' && obj.message.length > 0 ? obj.message : `HTTP ${httpStatus}`,
  );
  const detail = typeof obj.data === 'string' ? redactIds(obj.data) : null;

  if (httpStatus >= 200 && httpStatus < 300) {
    return obj.status === 'success'
      ? null
      : new FlutterwaveUnknownError(
          `Flutterwave ${method} ${path} answered HTTP ${httpStatus} with status "${String(obj.status)}"`,
          method,
          path,
        );
  }
  if (httpStatus === 429) return new FlutterwaveError('RATE_LIMITED', message, httpStatus, detail);
  if (httpStatus === 401 || httpStatus === 403) return new FlutterwaveError('CONFIG', message, httpStatus, detail);
  if (httpStatus === 404) return new FlutterwaveError('NOT_FOUND', message, httpStatus, detail);
  if (httpStatus === 408 || httpStatus >= 500) {
    return new FlutterwaveUnknownError(
      `Flutterwave ${method} ${path} answered HTTP ${httpStatus}: ${message}`,
      method,
      path,
    );
  }
  if (httpStatus >= 400) {
    const text = `${message} ${detail ?? ''}`;
    if (/ip whitelist/i.test(text)) return new FlutterwaveError('CONFIG', message, httpStatus, detail);
    if (/already exists/i.test(text)) return new FlutterwaveError('ALREADY_EXISTS', message, httpStatus, detail);
    if (/not found|no hook data|no transaction was found/i.test(text)) {
      return new FlutterwaveError('NOT_FOUND', message, httpStatus, detail);
    }
    return new FlutterwaveError('DEFINITE', message, httpStatus, detail);
  }
  return new FlutterwaveUnknownError(
    `Flutterwave ${method} ${path} answered unexpected HTTP ${httpStatus}`,
    method,
    path,
  );
}
