import type { Response } from 'express';

const EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/**
 * Sends a stored private file (H8).
 *
 * - `no-store`: nothing on the way (browser, proxy, CDN) keeps a copy.
 * - `nosniff` + the type detected at upload: the browser cannot decide it is HTML.
 * - `sandbox` CSP: even if it were, no script runs and nothing loads.
 * - A PDF downloads instead of opening inside the page; a picture shows inline.
 * - The file name is ours (the record id), never one a client sent.
 */
export function sendPrivateFile(res: Response, bytes: Buffer, contentType: string, name: string): void {
  const ext = EXTENSION[contentType] ?? 'bin';
  const disposition = contentType.startsWith('image/') ? 'inline' : 'attachment';
  res.setHeader('content-type', contentType);
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('content-security-policy', "sandbox; default-src 'none'");
  res.setHeader('content-disposition', `${disposition}; filename="${name.replace(/[^\w.-]/g, '_')}.${ext}"`);
  res.end(bytes);
}
