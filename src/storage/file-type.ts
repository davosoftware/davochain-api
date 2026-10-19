/**
 * A file's real type, from its first bytes (H8).
 *
 * Never from the name, the extension or the type the client claims: a file
 * that says image/png and is actually HTML is the oldest way to get a script
 * served back from an endpoint that promises a picture.
 */
export type KnownFileType = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

/** What a gift-card photo may be. */
export const IMAGE_TYPES: ReadonlySet<KnownFileType> = new Set(['image/jpeg', 'image/png', 'image/webp']);
/** What an ID document may be: a photo or a scanned PDF. */
export const DOCUMENT_TYPES: ReadonlySet<KnownFileType> = new Set([...IMAGE_TYPES, 'application/pdf']);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function detectFileType(buf: Buffer): KnownFileType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  // RIFF <4-byte size> WEBP — "RIFF" alone is also WAV and AVI.
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}
