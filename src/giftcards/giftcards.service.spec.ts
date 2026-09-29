import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GiftCardsService, decodeImage, detectImageType } from './giftcards.service';

/**
 * The parts of the gift card service that decide what the app is handed.
 *
 * The money paths are proved against a real database; what is here is the
 * behaviour a Flutter client would crash on if it quietly changed — the shape
 * of a public image URL, what a missing trade answers with, and whether a file
 * that merely claims to be a picture gets stored as one.
 */

/** The first bytes of a real one-pixel file of each kind we accept. */
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAA==', 'base64');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');

function service(over: { config?: Record<string, string>; trades?: unknown[] } = {}) {
  const prisma = {
    giftCardTrade: { findMany: jest.fn().mockResolvedValue(over.trades ?? []) },
  };
  const config = {
    get: (k: string) => (over.config ?? {})[k],
  };
  return new GiftCardsService(
    prisma as never,
    {} as never,
    {} as never,
    config as never,
  );
}

describe('detectImageType', () => {
  it('reads the type from the bytes', () => {
    expect(detectImageType(JPEG)).toBe('image/jpeg');
    expect(detectImageType(PNG)).toBe('image/png');
    expect(detectImageType(WEBP)).toBe('image/webp');
  });

  it('refuses a file that only claims to be a picture', () => {
    // The oldest way to get a script served back from an endpoint that
    // promises an image. The data URL's own label is never consulted.
    expect(detectImageType(Buffer.from('<html><script>x</script></html>'))).toBeNull();
    expect(detectImageType(Buffer.from('%PDF-1.7'))).toBeNull();
  });
});

describe('decodeImage', () => {
  it('takes a data URL and a bare base64 string alike', () => {
    expect(decodeImage(`data:image/png;base64,${PNG.toString('base64')}`).type).toBe('image/png');
    expect(decodeImage(PNG.toString('base64')).type).toBe('image/png');
  });

  it('rejects an empty one', () => {
    expect(() => decodeImage('data:image/png;base64,')).toThrow(BadRequestException);
  });

  it('rejects anything over 5 MB, with the message the app shows', () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]);
    expect(() => decodeImage(big.toString('base64'))).toThrow('Each image must be 5 MB or smaller');
  });

  it('rejects HTML wearing an image/png label', () => {
    const lie = Buffer.from('<html>hi</html>').toString('base64');
    expect(() => decodeImage(`data:image/png;base64,${lie}`)).toThrow(
      'Images must be JPEG, PNG or WebP',
    );
  });
});

describe('brandImageUrl', () => {
  const at = new Date('2026-09-09T12:00:00.000Z');

  it('is absolute, so a phone needs no prefixing rule of its own', () => {
    const s = service({ config: { PUBLIC_API_URL: 'https://api.davochain.com' } });
    expect(s.brandImageUrl({ id: 'b1', imageUpdatedAt: at })).toBe(
      `https://api.davochain.com/v1/giftcards/brands/b1/image?v=${at.getTime()}`,
    );
  });

  it('carries a version, which is what makes caching it forever safe', () => {
    const s = service({ config: { PUBLIC_API_URL: 'https://api.davochain.com' } });
    const older = s.brandImageUrl({ id: 'b1', imageUpdatedAt: new Date('2026-01-01T00:00:00Z') });
    const newer = s.brandImageUrl({ id: 'b1', imageUpdatedAt: at });
    expect(older).not.toBe(newer);
  });

  it('does not double the slash when the configured base has a trailing one', () => {
    const s = service({ config: { PUBLIC_API_URL: 'https://api.davochain.com/' } });
    expect(s.brandImageUrl({ id: 'b1', imageUpdatedAt: at })).toContain('.com/v1/giftcards');
  });

  it('is null when no logo was uploaded, so the app draws the name', () => {
    const s = service({ config: { PUBLIC_API_URL: 'https://api.davochain.com' } });
    expect(s.brandImageUrl({ id: 'b1', imageUpdatedAt: null })).toBeNull();
  });
});

describe('mine', () => {
  it('throws for a trade that is not theirs, rather than answering emptily', async () => {
    // Returning null here made Nest send 200 with a zero-byte body and no
    // content-type, which a client reads as success and then fails to parse.
    await expect(service().mine('user-1', 'someone-elses-id')).rejects.toThrow(NotFoundException);
  });

  it('gives an empty list, not a throw, when they simply have no trades', async () => {
    await expect(service().mine('user-1')).resolves.toEqual([]);
  });
});
