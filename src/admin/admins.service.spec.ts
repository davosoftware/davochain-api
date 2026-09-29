import { detectImageType, generatePassword } from './admins.service';

/**
 * The two pieces of this service that have to be right on their own, without a
 * database in front of them: what counts as an image, and what counts as a
 * password nobody chose.
 */
describe('detectImageType', () => {
  const png = (extra = 8) =>
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra)]);
  const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)]);
  const webp = () =>
    Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii')]);

  it('recognises the three formats we accept', () => {
    expect(detectImageType(png())).toBe('image/png');
    expect(detectImageType(jpeg())).toBe('image/jpeg');
    expect(detectImageType(webp())).toBe('image/webp');
  });

  it('refuses a file that only claims to be an image', () => {
    // The exact payload this check exists for: HTML stored under an image
    // content type, which some browsers will happily execute if served back.
    expect(detectImageType(Buffer.from('<script>alert(1)</script>'))).toBeNull();
    expect(detectImageType(Buffer.from('<svg onload="alert(1)"/>'))).toBeNull();
    expect(detectImageType(Buffer.from('GIF89a'))).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
  });

  it('is not fooled by the magic bytes appearing later in the file', () => {
    const hidden = Buffer.concat([Buffer.from('not an image'), png()]);
    expect(detectImageType(hidden)).toBeNull();
  });

  it('does not read past the end of a very short buffer', () => {
    expect(() => detectImageType(Buffer.from([0xff]))).not.toThrow();
    expect(detectImageType(Buffer.from([0xff]))).toBeNull();
    // "RIFF" with nothing after it — a truncated WebP header.
    expect(detectImageType(Buffer.from('RIFF', 'ascii'))).toBeNull();
  });
});

describe('generatePassword', () => {
  it('meets the same policy the API enforces on a chosen one', () => {
    for (let i = 0; i < 200; i++) {
      const pw = generatePassword();
      expect(pw.length).toBeGreaterThanOrEqual(10);
      expect(pw).toMatch(/[a-zA-Z]/);
      expect(pw).toMatch(/[0-9]/);
    }
  });

  it('leaves out the characters people misread when copying by hand', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePassword()).not.toMatch(/[IO01l]/);
    }
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generatePassword()));
    expect(seen.size).toBe(500);
  });

  it('does not always put the guaranteed classes in the same place', () => {
    // Without the shuffle every password would start upper/lower/digit, which
    // hands an attacker three positions for free.
    const firstChars = new Set(Array.from({ length: 100 }, () => generatePassword()[0]));
    expect(firstChars.size).toBeGreaterThan(5);
  });
});
