// Renders the "$RINSED is live" announcement to PNG.
// Run from the repo root: node marketing/x-article/live.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '../../scaffolds/fun-launch');
const sharp = createRequire(join(app, 'package.json'))('sharp');
const out = join(here, 'images');
mkdirSync(out, { recursive: true });

const TICKER = '$RINSED';
const DOMAIN = 'rinsed.fun';

const C = {
  bg: '#080C18',
  text: '#F2F6FF',
  muted: '#91A0BD',
  dim: '#5A6B8C',
  cyan: '#16D9F5',
  pink: '#F731BA',
  violet: '#9D73FA',
  green: '#2EE6A6',
};
const HEAVY = "'Segoe UI Black', 'Segoe UI', 'Arial Black', sans-serif";
const SEMI = "'Segoe UI Semibold', 'Segoe UI', sans-serif";
const BODY = "'Segoe UI', sans-serif";

const dataUri = async (file, width) =>
  `data:image/png;base64,${(await sharp(join(app, file)).resize({ width }).png().toBuffer()).toString('base64')}`;
const BUBBLE = await dataUri('rebrandedimages/rinsed-bubble-transparent.png', 900);
const WORDMARK = await dataUri('rebrandedimages/wordmarknew.png', 900);

const W = 1600, H = 900;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <radialGradient id="gc" cx="${W}" cy="0" r="900" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="${C.cyan}" stop-opacity="0.22"/><stop offset="1" stop-color="${C.cyan}" stop-opacity="0"/></radialGradient>
  <radialGradient id="gp" cx="0" cy="${H}" r="800" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="${C.pink}" stop-opacity="0.2"/><stop offset="1" stop-color="${C.pink}" stop-opacity="0"/></radialGradient>
  <radialGradient id="halo" cx="1230" cy="450" r="460" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="${C.violet}" stop-opacity="0.4"/><stop offset="0.55" stop-color="${C.pink}" stop-opacity="0.1"/><stop offset="1" stop-color="${C.pink}" stop-opacity="0"/></radialGradient>
  <linearGradient id="brand" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="${C.pink}"/><stop offset="0.5" stop-color="${C.violet}"/><stop offset="1" stop-color="${C.cyan}"/></linearGradient>
  <pattern id="dots" width="32" height="32" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.4" fill="#FFFFFF" fill-opacity="0.05"/></pattern>
</defs>
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<rect width="${W}" height="${H}" fill="url(#dots)"/>
<rect width="${W}" height="${H}" fill="url(#gc)"/>
<rect width="${W}" height="${H}" fill="url(#gp)"/>
<circle cx="1230" cy="450" r="460" fill="url(#halo)"/>
<image href="${BUBBLE}" x="940" y="160" width="580" height="580"/>
<image href="${BUBBLE}" x="900" y="96" width="96" height="96" opacity="0.8"/>
<image href="${BUBBLE}" x="1450" y="680" width="70" height="70" opacity="0.7"/>

<image href="${WORDMARK}" x="88" y="56" width="330" height="110"/>

<rect x="96" y="236" width="224" height="54" rx="27" fill="${C.green}" fill-opacity="0.12" stroke="${C.green}" stroke-opacity="0.55" stroke-width="2"/>
<circle cx="126" cy="263" r="15" fill="${C.green}" fill-opacity="0.25"/>
<circle cx="126" cy="263" r="8" fill="${C.green}"/>
<text x="148" y="273" font-family="${SEMI}" font-size="26" font-weight="600" fill="${C.green}" letter-spacing="3">LIVE NOW</text>

<text x="90" y="470" font-family="${HEAVY}" font-size="176" font-weight="900" fill="url(#brand)">${TICKER}</text>
<text x="92" y="606" font-family="${HEAVY}" font-size="132" font-weight="900" fill="${C.text}">is live.</text>

<text x="98" y="716" font-family="${BODY}" font-size="40" fill="${C.muted}">Deployed on <tspan font-family="${SEMI}" font-weight="600" fill="${C.cyan}">${DOMAIN}</tspan></text>

<text x="98" y="836" font-family="${BODY}" font-size="24" fill="${C.dim}">Fair launch · RINSE fee 90% → 1.25%</text>
<text x="1504" y="836" font-family="${BODY}" font-size="24" fill="${C.dim}" text-anchor="end">@rinseddotfun</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(join(out, 'rinsed-live.png'));
console.log('wrote images/rinsed-live.png');
