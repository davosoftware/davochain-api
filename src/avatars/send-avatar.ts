import type { Response } from 'express';

/**
 * A photo, cached for good: its link changes whenever the photo does. Private,
 * so only the signed-in device keeps it, and locked down like every stored file.
 */
export function sendAvatar(res: Response, bytes: Buffer): void {
  res.setHeader('content-type', 'image/webp');
  res.setHeader('cache-control', 'private, max-age=31536000, immutable');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('content-security-policy', "sandbox; default-src 'none'");
  res.setHeader('content-disposition', 'inline; filename="avatar.webp"');
  res.end(bytes);
}
