import sharp from 'sharp';

export function largeLaunchArtwork() {
  return sharp({ create: { width: 1740, height: 1000, channels: 3, background: '#FF7800' } })
    .png({ compressionLevel: 0 })
    .toBuffer();
}
