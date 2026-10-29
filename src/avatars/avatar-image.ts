import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import sharp from 'sharp';
import { IMAGE_TYPES, detectFileType } from '../storage/file-type';

/** What a customer may upload (29 Oct 2026). */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/** Every stored photo is this many pixels square. */
export const AVATAR_SIZE = 512;

/**
 * Pictures bigger than this are refused before they are opened: a small file
 * can claim to be 100,000 pixels square and take the server's memory with it.
 * 60 million covers a 48-megapixel phone photo.
 */
const MAX_INPUT_PIXELS = 60_000_000;

const notImage = () =>
  new BadRequestException({ code: 'AVATAR_NOT_IMAGE', message: 'Choose a photo: a JPEG, PNG or WebP picture.' });

/**
 * A customer's photo, made safe and small: turned the right way up, cropped
 * square from the centre, 512×512 WebP. Re-encoding drops everything but the
 * pixels, so the GPS location and camera details a phone hides in a photo
 * never reach storage.
 */
export async function shrinkAvatar(bytes: Buffer): Promise<Buffer> {
  if (bytes.length > AVATAR_MAX_BYTES) {
    throw new PayloadTooLargeException({ code: 'AVATAR_TOO_LARGE', message: 'Your photo must be 5 MB or smaller.' });
  }
  const type = detectFileType(bytes);
  if (!type || !IMAGE_TYPES.has(type)) throw notImage();
  try {
    return await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'centre' })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    throw notImage();
  }
}
