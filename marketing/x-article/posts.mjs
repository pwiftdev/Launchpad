// Renders the five anti-rugger post images to PNG.
// Run from the repo root: node marketing/x-article/posts.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '../../scaffolds/fun-launch');
const sharp = createRequire(join(app, 'package.json'))('sharp');
const out = join(here, 'images/posts');
mkdirSync(out, { recursive: true });

const C = {
  bg: '#080C18',
  surface: '#0E1424',
  panel: '#0B1120',
  line: '#1B2236',
  text: '#F2F6FF',
  muted: '#91A0BD',
  dim: '#5A6B8C',
  cyan: '#16D9F5',
  pink: '#F731BA',
  violet: '#9D73FA',
  green: '#2EE6A6',
  red: '#FF4D78',
  amber: '#FFB900',
};
const HEAVY = "'Segoe UI Black', 'Segoe UI', 'Arial Black', sans-serif";
const SEMI = "'Segoe UI Semibold', 'Segoe UI', sans-serif";
const BODY = "'Segoe UI', sans-serif";
const MONO = "Consolas, 'Segoe UI', monospace";

const dataUri = async (file, width) =>
  `data:image/png;base64,${(await sharp(join(app, file)).resize({ width }).png().toBuffer()).toString('base64')}`;
const BUBBLE = await dataUri('rebrandedimages/rinsed-bubble-transparent.png', 320);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const t = (x, y, s, { size = 24, font = BODY, weight = 400, fill = C.text, anchor = 'start', ls = 0, opacity = 1 } = {}) =>
  `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" letter-spacing="${ls}" opacity="${opacity}">${esc(s)}</text>`;
const box = (x, y, w, h, { r = 20, fill = C.surface, stroke = C.line, sw = 2, opacity = 1 } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"/>`;
const pillW = (s, size = 20) => s.length * size * (/[a-z]/.test(s) ? 0.56 : 0.64) + 40;
const pill = (x, y, s, color = C.cyan, size = 20) => {
  const w = pillW(s, size);
  return `<rect x="${x}" y="${y}" width="${w}" height="${size + 22}" rx="${(size + 22) / 2}" fill="${color}" fill-opacity="0.1" stroke="${color}" stroke-opacity="0.45" stroke-width="1.5"/>
    ${t(x + 20, y + size + 4, s, { size, font: SEMI, weight: 600, fill: color, ls: 1 })}`;
};
const pillRow = (x, y, items, size = 20, gap = 14) =>
  items
    .map(([s, color]) => {
      const p = pill(x, y, s, color, size);
      x += pillW(s, size) + gap;
      return p;
    })
    .join('');
const iconCircle = (cx, cy, r, color, inner) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" fill-opacity="0.12" stroke="${color}" stroke-opacity="0.5" stroke-width="2"/>
   <g transform="translate(${cx} ${cy})" stroke="${color}" fill="none" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`;
const ICON = {
  crosshair: `<circle r="16"/><path d="M0 -26v12M0 14v12M-26 0h12M14 0h12"/>`,
  person: `<circle cy="-9" r="9"/><path d="M-17 19c2-9 9-13 17-13s15 4 17 13"/>`,
};
const blockMark = (cx, cy, color = C.red) =>
  `<g transform="translate(${cx} ${cy})" stroke="${color}" fill="none" stroke-width="3" stroke-linecap="round"><circle r="11"/><path d="M-7.8 7.8l15.6-15.6"/></g>`;

/** 1600×900 post frame: headline, visual, brand footer. */
const frame = (title, body, { center = false } = {}) => {
  const W = 1600, H = 900;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <radialGradient id="gc" cx="${W * 0.88}" cy="0" r="${W * 0.5}" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="${C.cyan}" stop-opacity="0.2"/><stop offset="1" stop-color="${C.cyan}" stop-opacity="0"/></radialGradient>
  <radialGradient id="gp" cx="${W * 0.05}" cy="${H}" r="${W * 0.45}" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="${C.pink}" stop-opacity="0.16"/><stop offset="1" stop-color="${C.pink}" stop-opacity="0"/></radialGradient>
  <linearGradient id="brand" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="${C.pink}"/><stop offset="0.5" stop-color="${C.violet}"/><stop offset="1" stop-color="${C.cyan}"/></linearGradient>
  <pattern id="dots" width="32" height="32" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.4" fill="#FFFFFF" fill-opacity="0.05"/></pattern>
</defs>
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<rect width="${W}" height="${H}" fill="url(#dots)"/>
<rect width="${W}" height="${H}" fill="url(#gc)"/>
<rect width="${W}" height="${H}" fill="url(#gp)"/>
${t(center ? W / 2 : 96, 150, title, { size: 64, font: HEAVY, weight: 900, anchor: center ? 'middle' : 'start' })}
${body}
<image href="${BUBBLE}" x="92" y="806" width="48" height="48"/>
${t(150, 840, 'rinsed.fun', { size: 24, font: SEMI, weight: 600 })}
${t(1504, 840, '@rinseddotfun', { size: 22, fill: C.dim, anchor: 'end' })}
</svg>`;
};

const FEES = [90, 55.96, 34.8, 21.64, 13.45, 8.37, 5.2, 3.23, 2.01, 1.25];
const pct = (f) => `${f >= 10 ? Math.round(f) : f.toFixed(f < 2 ? 2 : 1)}%`;

// ---------- 01 the sniper's bad day ----------
const sniper = () => {
  const log = [
    ['t+00s', 'sniper.exe', 'BUY', FEES[0], C.red],
    ['t+03s', 'sniper.exe', 'BUY', FEES[1], C.red],
    ['t+06s', 'sniper.exe', 'BUY', FEES[2], C.pink],
    ['t+09s', 'sniper.exe', 'why', FEES[3], C.amber],
    ['t+12s', 'sniper.exe', '...', FEES[4], C.muted],
    ['t+15s', 'sniper.exe', 'offline', FEES[5], C.dim],
    null,
    ['t+27s', 'you', 'BUY', FEES[9], C.green],
  ];
  const lines = log
    .map((row, i) => {
      const y = 340 + i * 46;
      if (!row) return t(128, y, '·  ·  ·', { size: 24, font: MONO, fill: C.dim });
      const [time, who, action, fee, color] = row;
      const you = who === 'you';
      return `${you ? `<rect x="112" y="${y - 32}" width="728" height="44" rx="8" fill="${C.green}" fill-opacity="0.08"/>` : ''}
        ${t(128, y, time, { size: 24, font: MONO, fill: C.dim })}
        ${t(236, y, who, { size: 24, font: MONO, fill: you ? C.green : C.text })}
        ${t(420, y, action, { size: 24, font: MONO, fill: color })}
        ${t(816, y, `fee ${fee.toFixed(2)}%`, { size: 24, font: MONO, fill: color, anchor: 'end' })}`;
    })
    .join('');

  const base = 720, slot = 58.4, bw = 36, x0 = 920;
  const bars = FEES.map((f, i) => {
    const h = Math.max(6, (f / 90) * 400);
    const cx = x0 + slot * i + slot / 2;
    const color = i < 3 ? C.pink : i === 9 ? C.green : C.cyan;
    return `<rect x="${cx - bw / 2}" y="${base - h}" width="${bw}" height="${h}" rx="6" fill="${color}" fill-opacity="${i === 0 || i === 9 ? 1 : 0.55}"/>
      ${t(cx, base - h - 12, pct(f), { size: 16, font: MONO, fill: C.muted, anchor: 'middle' })}
      ${t(cx, base + 30, `${i * 3}s`, { size: 16, fill: C.dim, anchor: 'middle' })}`;
  }).join('');
  const first = x0 + slot / 2, last = x0 + slot * 9.5;

  return frame('Snipe at second 0. Pay 90%.', `
    ${box(96, 240, 760, 520, { fill: C.panel })}
    <circle cx="126" cy="272" r="7" fill="${C.red}"/><circle cx="150" cy="272" r="7" fill="${C.amber}"/><circle cx="174" cy="272" r="7" fill="${C.green}"/>
    ${t(200, 279, 'sniper.exe  —  trade log', { size: 18, font: MONO, fill: C.dim })}
    ${lines}
    ${t(128, 730, 'The RINSE fee steps down every 3 seconds.', { size: 22, fill: C.muted })}
    ${bars}
    ${iconCircle(first, 262, 34, C.pink, ICON.crosshair)}
    ${t(first + 46, 270, 'sniper', { size: 22, font: SEMI, weight: 600, fill: C.pink })}
    ${iconCircle(last, 630, 34, C.green, ICON.person)}
    ${t(last - 46, 638, 'you', { size: 22, font: SEMI, weight: 600, fill: C.green, anchor: 'end' })}`);
};

// ---------- 02 copycat rejection letter ----------
const copycat = () => {
  const rows = [
    ['$PEPE2', 'Lookalike name'],
    ['$PEPEE', 'Similar artwork'],
    ['Pepe (real)', 'Ticker already live elsewhere with $10K+ liquidity'],
  ];
  const checks = [
    'Ticker reused in the past hour',
    'Ticker already bonded here',
    'Lookalike names',
    'Similar artwork',
    'Reused X source post',
    'Ticker live elsewhere ($10K+ liq)',
  ];
  return frame('Dear copycat,', `
    ${t(96, 204, 'We regret to inform you that your launches could not be processed.', { size: 28, fill: C.muted })}
    ${box(96, 250, 900, 520, { fill: C.panel })}
    ${rows
      .map(([coin, why], i) => {
        const y = 330 + i * 100;
        return `${t(136, y, coin, { size: 34, font: MONO, weight: 700 })}
          ${t(136, y + 36, why, { size: 22, fill: C.muted })}
          ${blockMark(950, y - 10)}
          ${i < 2 ? `<path d="M136 ${y + 62} H 956" stroke="${C.line}" stroke-width="2"/>` : ''}`;
      })
      .join('')}
    <path d="M136 640 H 956" stroke="${C.line}" stroke-width="2"/>
    <text x="136" y="692" font-family="${BODY}" font-size="30" font-style="italic" fill="${C.text}">Please make something original.</text>
    ${t(136, 734, '— the rinsed.fun launch checks', { size: 22, fill: C.dim })}
    <g transform="translate(790 640) rotate(-12)">
      <rect x="-170" y="-50" width="340" height="100" rx="12" fill="${C.red}" fill-opacity="0.08" stroke="${C.red}" stroke-width="6"/>
      <text x="0" y="22" font-family="${HEAVY}" font-size="60" font-weight="900" fill="${C.red}" text-anchor="middle" letter-spacing="6">REJECTED</text>
    </g>
    ${pill(1060, 250, 'CHECKED BEFORE LAUNCH', C.cyan, 18)}
    ${checks
      .map((s, i) => {
        const y = 350 + i * 66;
        return `${blockMark(1074, y - 8)}${t(1100, y, s, { size: 21, fill: C.text })}`;
      })
      .join('')}`);
};

// ---------- 03 the dev's exit plan ----------
const plan = () => {
  const SIZE = 32;
  const width = (s) => s.length * SIZE * 0.49;
  const theirs = [
    ['1 Launch coin', null],
    ['2 Buy 40% of supply', 'capped at 2%'],
    ['3 Pull the liquidity', 'locked forever'],
    ['4 Profit', 'denied'],
  ];
  const ours = [
    ['1 First buy capped at 2%', 'of supply, at the floor fee'],
    ['2 Liquidity locked forever', 'when the coin graduates to DAMM v2'],
    ['3 ???', null],
    ['4 Find another job', null],
  ];
  return frame('Every rugger has a plan.', `
    ${box(96, 240, 680, 530, { fill: C.panel })}
    ${pill(128, 272, "THE RUGGER'S PLAN", C.red, 18)}
    ${theirs
      .map(([s, note], i) => {
        const y = 400 + i * 96;
        return `${t(136, y, s, { size: SIZE, font: SEMI, weight: 600, fill: note ? C.muted : C.text })}
          ${note ? `<path d="M130 ${y - 11} H ${142 + width(s)}" stroke="${C.red}" stroke-width="4" stroke-linecap="round"/>
          ${t(744, y, note, { size: 22, font: SEMI, weight: 600, fill: C.red, anchor: 'end' })}` : ''}`;
      })
      .join('')}
    ${box(824, 240, 680, 530, { fill: C.panel, stroke: C.green, sw: 2 })}
    ${pill(856, 272, 'ON RINSED.FUN', C.green, 18)}
    ${ours
      .map(([s, note], i) => {
        const y = 400 + i * 96;
        return `${t(864, y, s, { size: SIZE, font: SEMI, weight: 600, fill: i === 3 ? C.green : C.text })}
          ${note ? t(864, y + 36, note, { size: 20, fill: C.muted }) : ''}`;
      })
      .join('')}`);
};

// ---------- 04 thank you for your service ----------
const thanks = () => {
  const tags = [['BUYBACK FUNDED', C.pink], ['TOKENS BURNED', C.violet], ['RECEIPT ON-CHAIN', C.green]];
  const total = tags.reduce((sum, [s]) => sum + pillW(s, 18), 0) + 14 * (tags.length - 1);
  return frame('Thank you for your service.', `
    <rect x="250" y="200" width="1100" height="580" rx="24" fill="${C.panel}" stroke="url(#brand)" stroke-width="4"/>
    <rect x="270" y="220" width="1060" height="540" rx="14" fill="none" stroke="${C.line}" stroke-width="2"/>
    ${t(800, 290, 'CERTIFICATE OF APPRECIATION', { size: 26, font: SEMI, weight: 600, fill: C.cyan, anchor: 'middle', ls: 8 })}
    ${t(800, 350, 'Proudly awarded to', { size: 26, fill: C.muted, anchor: 'middle' })}
    <text x="800" y="450" font-family="${HEAVY}" font-size="84" font-weight="900" fill="url(#brand)" text-anchor="middle">Sniper Bot #4821</text>
    ${t(800, 516, 'for buying at second zero and paying the 90% RINSE fee,', { size: 28, anchor: 'middle' })}
    ${t(800, 556, 'which went on to fund a buyback and burn.', { size: 28, anchor: 'middle' })}
    ${pillRow(800 - total / 2, 600, tags, 18)}
    <path d="M330 712 H 600" stroke="${C.muted}" stroke-width="2"/>
    ${t(465, 742, 'Issued by rinsed.fun', { size: 20, fill: C.dim, anchor: 'middle' })}
    <circle cx="1220" cy="700" r="58" fill="none" stroke="${C.cyan}" stroke-opacity="0.5" stroke-width="2" stroke-dasharray="4 6"/>
    <image href="${BUBBLE}" x="1172" y="652" width="96" height="96"/>`, { center: true });
};

// ---------- 05 twelve tabs ----------
const tabs = () => {
  const titles = ['Explorer', 'DEX', 'Chart site', 'Launchpad', 'Telegram'];
  const windows = titles
    .map((s, i) => {
      const x = 96 + i * 24, y = 250 + i * 34;
      return `${box(x, y, 520, 360, { r: 14, fill: C.surface })}
        <circle cx="${x + 22}" cy="${y + 20}" r="5" fill="${C.dim}"/><circle cx="${x + 40}" cy="${y + 20}" r="5" fill="${C.dim}"/><circle cx="${x + 58}" cy="${y + 20}" r="5" fill="${C.dim}"/>
        ${t(x + 80, y + 27, s, { size: 18, font: SEMI, weight: 600, fill: C.muted })}
        <path d="M${x} ${y + 40} H ${x + 520}" stroke="${C.line}" stroke-width="2"/>`;
    })
    .join('');
  const fx = 96 + 4 * 24, fy = 250 + 4 * 34;
  const chat = [
    ['SEND IT', C.pink, 0],
    ['ser wen chart??', C.muted, 120],
    ['dev is based trust', C.muted, 0],
    ['SEND IT SEND IT', C.pink, 90],
    ['wait where did the LP go', C.amber, 0],
  ];
  const bubbles = chat
    .map(([s, color, dx], i) => {
      const y = fy + 64 + i * 56, w = s.length * 22 * 0.56 + 36;
      return `<rect x="${fx + 24 + dx}" y="${y}" width="${w}" height="42" rx="21" fill="${color}" fill-opacity="0.12"/>
        ${t(fx + 42 + dx, y + 28, s, { size: 22, font: SEMI, weight: 600, fill: color })}`;
    })
    .join('');

  // Seeded candles for the terminal mock.
  let seed = 5, price = 210;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const walk = Array.from({ length: 22 }, () => {
    const open = price;
    const close = Math.max(40, open + (rand() - 0.42) * 34);
    price = close;
    return { open, close, high: Math.max(open, close) + rand() * 10, low: Math.min(open, close) - rand() * 10 };
  });
  const lo = Math.min(...walk.map((c) => c.low)), hi = Math.max(...walk.map((c) => c.high));
  const candles = walk.map(({ open, close, high, low }, i) => {
    const cx = 900 + i * 17 + 8, y = (v) => 630 - ((v - lo) / (hi - lo)) * 250;
    const color = close >= open ? C.green : C.red;
    return `<path d="M${cx} ${y(high)} V ${y(low)}" stroke="${color}" stroke-width="2"/>
      <rect x="${cx - 5}" y="${y(Math.max(open, close))}" width="10" height="${Math.max(2, Math.abs(y(close) - y(open)))}" fill="${color}"/>`;
  }).join('');

  const rx = 1294;
  return frame('12 tabs or 1 terminal.', `
    ${windows}
    ${bubbles}
    <circle cx="${fx + 520}" cy="${fy}" r="28" fill="${C.red}"/>
    ${t(fx + 520, fy + 9, '12', { size: 26, font: HEAVY, weight: 900, anchor: 'middle' })}
    <path d="M748 500 H 820 M800 482 L 822 500 L 800 518" stroke="${C.cyan}" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    ${box(852, 240, 652, 530, { fill: C.panel, stroke: C.cyan, sw: 2 })}
    ${t(884, 286, 'RINSED Terminal', { size: 24, font: SEMI, weight: 600, fill: C.cyan })}
    ${t(1472, 286, 'Soapy Frog $SOAP · sample', { size: 18, fill: C.dim, anchor: 'end' })}
    <rect x="884" y="306" width="588" height="40" rx="10" fill="${C.pink}" fill-opacity="0.1" stroke="${C.pink}" stroke-opacity="0.45"/>
    ${t(902, 333, 'RINSE  8.37%', { size: 19, font: MONO, fill: C.pink })}
    ${t(1454, 333, 'next 5.20% in 2s', { size: 19, font: MONO, fill: C.muted, anchor: 'end' })}
    ${candles}
    ${t(884, 676, 'Bonding curve', { size: 18, fill: C.muted })}
    ${t(1270, 676, '42%', { size: 18, font: MONO, fill: C.text, anchor: 'end' })}
    <rect x="884" y="690" width="386" height="10" rx="5" fill="${C.line}"/>
    <rect x="884" y="690" width="${386 * 0.42}" height="10" rx="5" fill="${C.cyan}"/>
    ${t(884, 740, 'Live tape · holders · top traders', { size: 18, fill: C.dim })}
    <path d="M1278 366 V 744" stroke="${C.line}" stroke-width="2"/>
    ${t(rx, 392, 'Buy', { size: 22, font: SEMI, weight: 600, fill: C.green })}
    ${['0.1', '0.5', '1']
      .map((s, i) => `${box(rx + i * 62, 410, 54, 40, { r: 8, fill: i === 1 ? C.cyan : C.surface, stroke: i === 1 ? C.cyan : C.line, opacity: i === 1 ? 0.25 : 1 })}${t(rx + i * 62 + 27, 437, s, { size: 18, font: MONO, anchor: 'middle' })}`)
      .join('')}
    ${t(rx, 494, 'You pay', { size: 17, fill: C.dim })}${t(1472, 494, '0.5 SOL', { size: 17, font: MONO, anchor: 'end' })}
    ${t(rx, 528, 'You get', { size: 17, fill: C.dim })}${t(1472, 528, '1.2M SOAP', { size: 17, font: MONO, anchor: 'end' })}
    <rect x="${rx}" y="552" width="178" height="62" rx="10" fill="${C.green}" fill-opacity="0.08" stroke="${C.green}" stroke-opacity="0.45"/>
    ${t(rx + 14, 578, 'Fee before you sign', { size: 15, font: SEMI, weight: 600, fill: C.green })}
    ${t(rx + 14, 603, '8.37%', { size: 19, font: MONO, fill: C.green })}
    <rect x="${rx}" y="632" width="178" height="52" rx="10" fill="${C.cyan}"/>
    ${t(rx + 89, 666, 'Buy SOAP', { size: 20, font: SEMI, weight: 600, fill: C.bg, anchor: 'middle' })}`);
};

const only = process.argv[2];
for (const [name, build] of Object.entries({ '01-sniper': sniper, '02-copycat': copycat, '03-dev-plan': plan, '04-thank-you': thanks, '05-twelve-tabs': tabs })) {
  if (only && !name.startsWith(only)) continue;
  await sharp(Buffer.from(build())).png().toFile(join(out, `${name}.png`));
  console.log(`wrote images/posts/${name}.png`);
}
