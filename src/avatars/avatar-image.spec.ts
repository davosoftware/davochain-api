import sharp from 'sharp';
import { AVATAR_MAX_BYTES, AVATAR_SIZE, shrinkAvatar } from './avatar-image';

const photo = (width: number, height: number, format: 'jpeg' | 'png' | 'webp' = 'jpeg') =>
  sharp({ create: { width, height, channels: 3, background: '#135CF7' } })[format]().toBuffer();

describe('shrinkAvatar', () => {
  it('makes any photo a 512×512 WebP', async () => {
    for (const format of ['jpeg', 'png', 'webp'] as const) {
      const out = await shrinkAvatar(await photo(1200, 800, format));
      const meta = await sharp(out).metadata();
      expect(meta).toMatchObject({ format: 'webp', width: AVATAR_SIZE, height: AVATAR_SIZE });
      expect(out.length).toBeLessThan(100_000);
    }
  });

  it('removes hidden data such as the GPS location', async () => {
    const withGps = await sharp(await photo(800, 800))
      .withExif({ IFD0: { Make: 'Phone', Copyright: 'Ada' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '6/1 27/1 0/1' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(withGps).metadata()).exif).toBeDefined();
    const out = await shrinkAvatar(withGps);
    const meta = await sharp(out).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
  });

  it('turns a sideways phone photo the right way up', async () => {
    // A tall, thin picture saved lying on its side (orientation 6 = rotate 90°).
    const left = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#ff0000' } })
      .composite([{ input: { create: { width: 200, height: 200, channels: 3, background: '#0000ff' } }, left: 200, top: 0 }])
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const out = await shrinkAvatar(left);
    // Upright, the red half is on top and the blue half below.
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => data[(y * info.width + x) * info.channels + 2];
    expect(at(256, 40)).toBeLessThan(100); // top: little blue
    expect(at(256, 470)).toBeGreaterThan(150); // bottom: blue
  });

  it.each([
    ['not an image', Buffer.from('<html><script>alert(1)</script></html>')],
    ['a PDF', Buffer.from('%PDF-1.7 rest of file')],
    ['empty', Buffer.alloc(0)],
  ])('refuses %s', async (_name, bytes) => {
    await expect(shrinkAvatar(bytes)).rejects.toMatchObject({ response: { code: 'AVATAR_NOT_IMAGE' } });
  });

  it('refuses a broken image that only starts like one', async () => {
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(200, 7)]);
    await expect(shrinkAvatar(broken)).rejects.toMatchObject({ response: { code: 'AVATAR_NOT_IMAGE' } });
  });

  it('refuses a file over 5 MB before reading it', async () => {
    expect(AVATAR_MAX_BYTES).toBe(5 * 1024 * 1024);
    const big = Buffer.concat([await photo(10, 10), Buffer.alloc(AVATAR_MAX_BYTES)]);
    await expect(shrinkAvatar(big)).rejects.toMatchObject({ response: { code: 'AVATAR_TOO_LARGE' } });
  });

  it('refuses a picture too big to open safely (a "pixel bomb")', async () => {
    const huge = await sharp({ create: { width: 9000, height: 9000, channels: 3, background: '#000' } }).png({ compressionLevel: 9 }).toBuffer();
    await expect(shrinkAvatar(huge)).rejects.toMatchObject({ response: { code: 'AVATAR_NOT_IMAGE' } });
  });
});
