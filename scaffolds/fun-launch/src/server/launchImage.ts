import sharp from 'sharp';

/** Fully decode, orient and strip metadata before publishing bounded, static token artwork. */
export async function normalizeLaunchImage(input: { buffer: Buffer; contentType: string } | null) {
  if (!input || !input.buffer.length || input.buffer.length > 2 * 1024 * 1024)
    throw new Error('Image must be 2 MB or smaller');
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
