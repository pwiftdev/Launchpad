// Web-sized derivatives of the supplied artwork. Originals remain untouched.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(new URL('../scaffolds/fun-launch/package.json', import.meta.url));
const sharp = require('sharp');
const app = path.resolve('scaffolds/fun-launch');
const source = path.join(app, 'rebrandedimages');
const output = path.join(app, 'public/brand');
await mkdir(output, { recursive: true });

const mark = await sharp(path.join(source, 'rinsed-bubble-transparent.png'))
  .trim({ threshold: 12 })
  .png()
  .toBuffer();
const wordmark = await sharp(path.join(source, 'wordmarknew.png'))
  .trim({ threshold: 12 })
  .png()
  .toBuffer();
await sharp(mark)
  .resize(256, 256, { fit: 'contain', background: '#00000000' })
  .webp({ quality: 92, alphaQuality: 100 })
  .toFile(path.join(output, 'mark.webp'));
await sharp(mark)
  .resize(512, 512, { fit: 'contain', background: '#00000000' })
  .png()
  .toFile(path.join(output, 'mark.png'));
await sharp(wordmark)
  .resize({ width: 1024 })
  .webp({ quality: 95, alphaQuality: 100 })
  .toFile(path.join(output, 'wordmark.webp'));
await sharp(wordmark).resize({ width: 1280 }).png().toFile(path.join(output, 'wordmark.png'));
await sharp(path.join(source, 'rinsed-bubble-dark.png'))
  .resize(192, 192)
  .png()
  .toFile(path.join(output, 'icon-dark.png'));
await sharp(path.join(source, 'rinsed-bubble-white.png'))
  .resize(192, 192)
  .png()
  .toFile(path.join(output, 'icon-light.png'));
await sharp(path.join(source, 'rinsed-bubble-dark.png'))
  .resize(180, 180)
  .png()
  .toFile(path.join(output, 'apple-touch-icon.png'));
await sharp(mark)
  .resize(32, 32, { fit: 'contain', background: '#00000000' })
  .png()
  .toFile(path.join(output, 'favicon-32.png'));
const icon = await sharp(mark)
  .resize(48, 48, { fit: 'contain', background: '#00000000' })
  .png()
  .toBuffer();
const directory = Buffer.alloc(22);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(1, 4);
directory[6] = 48;
directory[7] = 48;
directory.writeUInt16LE(1, 10);
directory.writeUInt16LE(32, 12);
directory.writeUInt32LE(icon.length, 14);
directory.writeUInt32LE(22, 18);
await writeFile(path.join(app, 'public/favicon.ico'), Buffer.concat([directory, icon]));
const legacy = await sharp(mark)
  .resize(128, 128, { fit: 'contain', background: '#00000000' })
  .png()
  .toBuffer();
await writeFile(
  path.join(app, 'public/logo.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><image width="128" height="128" href="data:image/png;base64,${legacy.toString('base64')}"/></svg>\n`
);
console.log('Prepared bubble mark, supplied wordmark, app icons and favicons.');
