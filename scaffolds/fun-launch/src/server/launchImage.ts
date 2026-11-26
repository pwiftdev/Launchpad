import sharp from 'sharp';
import {
  LAUNCH_IMAGE_MAX_BYTES,
  LAUNCH_IMAGE_MAX_DATA_URL_LENGTH,
  LAUNCH_IMAGE_MAX_MB,
} from '@/constants/launch';

/** Fully decode, orient and strip metadata before publishing bounded, static token artwork. */
export async function normalizeLaunchImage(input: { buffer: Buffer; contentType: string } | null) {
  if (!input || !input.buffer.length || input.buffer.length > LAUNCH_IMAGE_MAX_BYTES)
    throw new Error(`Image must be ${LAUNCH_IMAGE_MAX_MB} MB or smaller`);
  const pipeline = sharp(input.buffer, {
    limitInputPixels: 16_777_216,
    animated: false,
    failOn: 'warning',
  });
  const metadata = await pipeline.metadata();
  const formats: Record<string, string> = {
    png: 'image/png',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
  };
  if (!metadata.width || !metadata.height || formats[metadata.format] !== input.contentType)
    throw new Error('Invalid image format');
  const buffer = await pipeline
    .rotate()
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer();
  if (buffer.length > 2 * 1024 * 1024) throw new Error('Processed image is too large');
  return { buffer, contentType: 'image/webp' };
}

/** Decodes a base64 image data URL, accepting only the image types the launch form allows. */
export function decodeDataUrl(dataUrl: string): { contentType: string; buffer: Buffer } | null {
  if (dataUrl.length > LAUNCH_IMAGE_MAX_DATA_URL_LENGTH) return null;
  const matches = dataUrl.match(
    /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/
  );
  if (!matches?.[1] || !matches[2]) return null;
  const buffer = Buffer.from(matches[2], 'base64');
  if (
    !buffer.length ||
    buffer.length > LAUNCH_IMAGE_MAX_BYTES ||
    buffer.toString('base64') !== matches[2]
  )
    return null;
  return { contentType: matches[1], buffer };
}
