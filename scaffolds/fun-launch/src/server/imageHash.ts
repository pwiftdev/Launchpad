// Server-only: perceptual image hashing for the copied-image check.
import sharp from 'sharp';
import { fetchRemote } from './remote';

/**
 * 64-bit difference hash (dHash) as 16 hex chars. Robust to resizing, recompression and
 * recolouring, because it only compares the brightness of neighbouring pixels.
 */
export async function imageHash(input: Buffer): Promise<string> {
  const pixels = await sharp(input, { animated: false, limitInputPixels: 16_777_216 })
    .flatten({ background: '#ffffff' })
    .grayscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer();
  let hex = '';
  if (pixels.length !== 72) throw new Error('Unexpected image hash dimensions');
  for (let row = 0; row < 8; row++) {
    let nibbleHigh = 0;
    let nibbleLow = 0;
    for (let col = 0; col < 8; col++) {
      const bit = pixels.readUInt8(row * 9 + col) > pixels.readUInt8(row * 9 + col + 1) ? 1 : 0;
      if (col < 4) nibbleHigh = (nibbleHigh << 1) | bit;
      else nibbleLow = (nibbleLow << 1) | bit;
    }
    hex += nibbleHigh.toString(16) + nibbleLow.toString(16);
  }
  return hex;
}

// Images of launched coins never change (immutable metadata), so their hashes are cached forever
const remoteHashes = new Map<string, Promise<string | null>>();

/** Hash of a coin's image by URL, or null if it can't be fetched or decoded. */
export function remoteImageHash(url: string): Promise<string | null> {
  let pending = remoteHashes.get(url);
  if (!pending) {
    pending = fetchRemote(url, 2 * 1024 * 1024)
      .then(imageHash)
      .catch((): null => null);
    const oldest = remoteHashes.keys().next().value;
    if (remoteHashes.size >= 1000 && oldest !== undefined) remoteHashes.delete(oldest);
    remoteHashes.set(url, pending);
  }
  return pending;
}
