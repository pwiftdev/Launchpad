import { expect, it } from 'vitest';
import sharp from 'sharp';
import { normalizeLaunchImage } from './launchImage';

it('publishes bounded static WebP artwork with private metadata stripped', async () => {
  const original = await sharp({
    create: { width: 1600, height: 800, channels: 3, background: '#123456' },
  })
    .withMetadata({ exif: { IFD0: { Artist: 'Private uploader name' } } })
    .jpeg()
    .toBuffer();
  const result = await normalizeLaunchImage({ buffer: original, contentType: 'image/jpeg' });
  const metadata = await sharp(result.buffer).metadata();
  expect(result.contentType).toBe('image/webp');
  expect([metadata.width, metadata.height]).toEqual([1024, 512]);
  expect(metadata.exif).toBeUndefined();
  expect(metadata.pages ?? 1).toBe(1);
});
it('rejects mismatched, incomplete, oversized and decompression-heavy input before upload', async () => {
  const png = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#123456' } })
    .png()
    .toBuffer();
  await expect(normalizeLaunchImage({ buffer: png, contentType: 'image/jpeg' })).rejects.toThrow();
  await expect(
    normalizeLaunchImage({ buffer: png.subarray(0, 48), contentType: 'image/png' })
  ).rejects.toThrow();
  await expect(
    normalizeLaunchImage({ buffer: Buffer.alloc(2 * 1024 * 1024 + 1), contentType: 'image/png' })
  ).rejects.toThrow();
  const large = await sharp({
    create: { width: 4097, height: 4097, channels: 3, background: '#123456' },
  })
    .png()
    .toBuffer();
  await expect(normalizeLaunchImage({ buffer: large, contentType: 'image/png' })).rejects.toThrow();
});
