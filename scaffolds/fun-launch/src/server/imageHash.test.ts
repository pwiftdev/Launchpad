import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { hashDistance } from '@/lib/antivamp/rules';
import { ANTIVAMP_IMAGE_DISTANCE } from '@/constants/launch';
import { imageHash } from './imageHash';

const svg = (body: string) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">${body}</svg>`);

// A simple "coin logo": background, big circle, bar
const original = svg(
  '<rect width="256" height="256" fill="#0a1020"/><circle cx="100" cy="120" r="70" fill="#3ec7ff"/><rect x="150" y="40" width="60" height="170" fill="#ff5fa2"/>'
);
const different = svg(
  '<rect width="256" height="256" fill="#ffffff"/><polygon points="128,20 236,236 20,236" fill="#222"/><circle cx="128" cy="170" r="30" fill="#e00"/>'
);

describe('imageHash', () => {
  it('matches a recoloured, resized, re-encoded copy', async () => {
    const base = await sharp(original).png().toBuffer();
    const copy = await sharp(original)
      .modulate({ hue: 90, saturation: 1.4 })
      .resize(180, 180)
      .jpeg({ quality: 60 })
      .toBuffer();
    const d = hashDistance(await imageHash(base), await imageHash(copy));
    expect(d).toBeLessThanOrEqual(ANTIVAMP_IMAGE_DISTANCE);
  });

  it('does not match a different image', async () => {
    const a = await sharp(original).png().toBuffer();
    const b = await sharp(different).png().toBuffer();
    expect(hashDistance(await imageHash(a), await imageHash(b))).toBeGreaterThan(
      ANTIVAMP_IMAGE_DISTANCE
    );
  });
});
