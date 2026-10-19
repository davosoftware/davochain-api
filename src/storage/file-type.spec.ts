import { DOCUMENT_TYPES, IMAGE_TYPES, detectFileType } from './file-type';

const bytes = (...parts: (number[] | string)[]) =>
  Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));

describe('detectFileType', () => {
  it('recognises JPEG, PNG, WebP and PDF from their first bytes', () => {
    expect(detectFileType(bytes([0xff, 0xd8, 0xff, 0xe0], 'rest'))).toBe('image/jpeg');
    expect(detectFileType(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'rest'))).toBe('image/png');
    expect(detectFileType(bytes('RIFF', [1, 2, 3, 4], 'WEBPVP8 '))).toBe('image/webp');
    expect(detectFileType(bytes('%PDF-1.7\n'))).toBe('application/pdf');
  });

  it('refuses a RIFF file that is not WebP (the old check let a WAV through)', () => {
    expect(detectFileType(bytes('RIFF', [1, 2, 3, 4], 'WAVEfmt '))).toBeNull();
  });

  it('refuses HTML, SVG, text and an empty file whatever they claim to be', () => {
    expect(detectFileType(bytes('<html><script>alert(1)</script>'))).toBeNull();
    expect(detectFileType(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(detectFileType(bytes('just text'))).toBeNull();
    expect(detectFileType(Buffer.alloc(0))).toBeNull();
  });

  it('refuses a PNG signature cut short', () => {
    expect(detectFileType(bytes([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it('lists pictures only for gift cards, pictures plus PDF for documents', () => {
    expect([...IMAGE_TYPES].sort()).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    expect([...DOCUMENT_TYPES].sort()).toEqual(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
  });
});
