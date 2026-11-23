// Renders the X article cover and section explainers to PNG.
// Run from the repo root: node marketing/x-article/render.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '../../scaffolds/fun-launch');
const sharp = createRequire(join(app, 'package.json'))('sharp');
const out = join(here, 'images');
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
const BUBBLE = await dataUri('rebrandedimages/rinsed-bubble-transparent.png', 640);
const WORDMARK = await dataUri('rebrandedimages/wordmarknew.png', 900);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const t = (x, y, s, { size = 24, font = BODY, weight = 400, fill = C.text, anchor = 'start', ls = 0, opacity = 1 } = {}) =>
  `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" letter-spacing="${ls}" opacity="${opacity}">${esc(s)}</text>`;
const box = (x, y, w, h, { r = 20, fill = C.surface, stroke = C.line, sw = 2, opacity = 1 } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"/>`;
// All-caps labels with letter-spacing run wider than mixed-case text.
const pillW = (s, size = 20) => s.length * size * (/[a-z]/.test(s) ? 0.56 : 0.64) + 40;
const pill = (x, y, s, color = C.cyan, size = 20) => {
  const w = pillW(s, size);
  return `${box(x, y, w, size + 22, { r: (size + 22) / 2, fill: color, stroke: color, sw: 1.5, opacity: 0.1 })}
    <rect x="${x}" y="${y}" width="${w}" height="${size + 22}" rx="${(size + 22) / 2}" fill="none" stroke="${color}" stroke-opacity="0.45" stroke-width="1.5"/>
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
  crosshair: `<circle r="16"/><path d="M0 -26v12M0 14v12M-26 0h12M14 0h12"/><circle r="3" fill="currentColor"/>`,
  bundle: `<circle cx="-10" cy="-8" r="9"/><circle cx="12" cy="-8" r="9"/><circle cx="1" cy="12" r="9"/>`,
  copy: `<rect x="-18" y="-18" width="24" height="24" rx="4"/><rect x="-6" y="-6" width="24" height="24" rx="4"/>`,
  check: `<path d="M-13 1l8 8 17-18"/>`,
  block: `<circle r="15"/><path d="M-10.5 10.5l21-21"/>`,
  coins: `<ellipse cx="0" cy="-10" rx="17" ry="7"/><path d="M-17 -10v10c0 4 8 7 17 7s17-3 17-7v-10M-17 0v10c0 4 8 7 17 7s17-3 17-7V0"/>`,
  cycle: `<path d="M-16 -4a16 16 0 0 1 28-9M16 4a16 16 0 0 1-28 9"/><path d="M12 -22v9h-9M-12 22v-9h9"/>`,
  flame: `<path d="M0 22c-11 0-17-8-17-16 0-10 9-15 10-25 6 5 9 10 8 16 3-2 5-5 5-9 6 5 11 11 11 18 0 9-7 16-17 16z"/>`,
  receipt: `<path d="M-14 -20h28v40l-7-5-7 5-7-5-7 5z"/><path d="M-7 -9h14M-7 0h14M-7 9h8"/>`,
  person: `<circle cy="-9" r="9"/><path d="M-17 19c2-9 9-13 17-13s15 4 17 13"/>`,
  group: `<circle cx="-11" cy="-8" r="7"/><circle cx="11" cy="-8" r="7"/><path d="M-24 17c1-7 6-11 13-11s12 4 13 11M-2 17c1-7 6-11 13-11s12 4 13 11"/>`,
  lock: `<rect x="-17" y="-4" width="34" height="26" rx="5"/><path d="M-10 -4v-8a10 10 0 0 1 20 0v8"/><circle cy="9" r="2.5"/>`,
  warn: `<path d="M0 -20l20 36h-40z"/><path d="M0 -6v10M0 11v1"/>`,
  chart: `<path d="M-18 14l10-12 9 7 15-19"/><path d="M-20 20h40"/>`,
};

const defs = (w, h) => `<defs>
  <radialGradient id="gc" cx="${w * 0.88}" cy="0" r="${w * 0.5}" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="${C.cyan}" stop-opacity="0.2"/><stop offset="1" stop-color="${C.cyan}" stop-opacity="0"/></radialGradient>
  <radialGradient id="gp" cx="${w * 0.05}" cy="${h}" r="${w * 0.45}" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="${C.pink}" stop-opacity="0.16"/><stop offset="1" stop-color="${C.pink}" stop-opacity="0"/></radialGradient>
  <linearGradient id="brand" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="${C.pink}"/><stop offset="0.5" stop-color="${C.violet}"/><stop offset="1" stop-color="${C.cyan}"/></linearGradient>
  <linearGradient id="fill" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="${C.cyan}"/><stop offset="1" stop-color="${C.violet}"/></linearGradient>
  <pattern id="dots" width="32" height="32" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.4" fill="#FFFFFF" fill-opacity="0.05"/></pattern>
</defs>
<rect width="${w}" height="${h}" fill="${C.bg}"/>
<rect width="${w}" height="${h}" fill="url(#dots)"/>
<rect width="${w}" height="${h}" fill="url(#gc)"/>
<rect width="${w}" height="${h}" fill="url(#gp)"/>`;

/** Shared 1600×900 explainer frame: section label, headline, visual, brand footer. */
const frame = ({ n, label, title, sub, body }) => {
  const W = 1600, H = 900;
  const titleY = 200;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${defs(W, H)}
${pill(96, 76, `${String(n).padStart(2, '0')} · ${label.toUpperCase()}`)}
${title.map((line, i) => t(96, titleY + i * 74, line, { size: 64, font: HEAVY, weight: 900 })).join('')}
${sub ? t(96, titleY + title.length * 74 - 14, sub, { size: 28, fill: C.muted }) : ''}
${body}
<image href="${BUBBLE}" x="92" y="806" width="48" height="48"/>
${t(150, 840, 'rinsed.fun', { size: 24, font: SEMI, weight: 600 })}
${t(1504, 840, '@rinseddotfun', { size: 22, fill: C.dim, anchor: 'end' })}
</svg>`;
};

// ---------- 00 banner (X article cover, 5:2) ----------
const banner = () => {
  const W = 2000, H = 800;
  const tags = ['RINSE fee 90% → 1.25%', 'Anti-copycat checks', 'Buybacks & burns', 'RINSED Terminal'];
  let x = 120;
  const pills = tags
    .map((s, i) => {
      const color = [C.pink, C.violet, C.cyan, C.green][i];
      const p = pill(x, 640, s, color, 22);
      x += pillW(s, 22) + 16;
      return p;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${defs(W, H)}
<radialGradient id="halo" cx="1600" cy="400" r="420" gradientUnits="userSpaceOnUse">
  <stop offset="0" stop-color="${C.violet}" stop-opacity="0.34"/><stop offset="0.55" stop-color="${C.pink}" stop-opacity="0.08"/><stop offset="1" stop-color="${C.pink}" stop-opacity="0"/></radialGradient>
<circle cx="1600" cy="400" r="420" fill="url(#halo)"/>
<image href="${BUBBLE}" x="1310" y="110" width="580" height="580"/>
<image href="${BUBBLE}" x="1260" y="70" width="110" height="110" opacity="0.85"/>
<image href="${BUBBLE}" x="1820" y="610" width="64" height="64" opacity="0.7"/>
<image href="${BUBBLE}" x="1830" y="80" width="80" height="80" opacity="0.7"/>
<image href="${WORDMARK}" x="104" y="40" width="420" height="140"/>
${t(120, 340, 'Enough rugging', { size: 124, font: HEAVY, weight: 900 })}
<text x="120" y="480" font-family="${HEAVY}" font-size="124" font-weight="900" fill="url(#brand)">in the trenches.</text>
${t(124, 575, 'A safer way to launch and trade on Solana.', { size: 40, fill: C.muted })}
${pills}
</svg>`;
};

// ---------- 01 the trenches ----------
const trenches = () => {
  const cards = [
    ['crosshair', 'Sniper bots', ['Take the first block, then', 'dump on the first buyers.']],
    ['bundle', 'Bundles', ['Fresh wallets buy in one', 'second and sit on supply.']],
    ['copy', 'Copycats', ['Same ticker, same art,', 'siphoning your volume.']],
  ];
  const spark = (x, y) =>
    `<polyline points="${[0, 8, 4, 60, 50, 140, 150, 170, 200, 190, 230, 200]
      .map((v, i) => `${x + i * 34},${y + 4 + v * 0.42}`)
      .join(' ')}" fill="none" stroke="${C.red}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>`;
  return frame({
    n: 1,
    label: 'The trenches',
    title: ['The trenches are rigged.'],
    sub: 'The fastest, most aggressive wallet wins. Everyone else is exit liquidity.',
    body: cards
      .map(([icon, head, lines], i) => {
        const x = 96 + i * 484;
        return `${box(x, 380, 440, 380)}
          ${iconCircle(x + 72, 452, 40, C.red, ICON[icon])}
          ${t(x + 40, 548, head, { size: 38, font: HEAVY, weight: 900 })}
          ${lines.map((l, j) => t(x + 40, 592 + j * 34, l, { size: 25, fill: C.muted })).join('')}
          ${spark(x + 40, 650)}`;
      })
      .join(''),
  });
};

// ---------- 02 RINSE fee schedule ----------
const STEPS = [90, 55.96, 34.8, 21.64, 13.45, 8.37, 5.2, 3.23, 2.01, 1.25];
const fmt = (p) => (p <= 1.26 ? '1.25%' : p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`);
const mix = (a, b, k) => {
  const pa = a.match(/\w\w/g).map((h) => parseInt(h, 16));
  const pb = b.match(/\w\w/g).map((h) => parseInt(h, 16));
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * k).toString(16).padStart(2, '0')).join('')}`;
};
const rinse = () => {
  const base = 740, maxH = 330, slot = 140.8;
  const bars = STEPS.map((p, i) => {
    const h = Math.max((p / 90) * maxH, 6);
    const x = 96 + i * slot + 22;
    const k = i / (STEPS.length - 1);
    const color = i === STEPS.length - 1 ? C.green : k < 0.5 ? mix(C.pink, C.violet, k * 2) : mix(C.violet, C.cyan, (k - 0.5) * 2);
    return `<rect x="${x}" y="${base - h}" width="96" height="${h}" rx="10" fill="${color}"/>
      ${t(x + 48, base - h - 16, fmt(p), { size: 28, font: HEAVY, weight: 900, anchor: 'middle', fill: i === STEPS.length - 1 ? C.green : C.text })}
      ${t(x + 48, base + 40, `${i * 3}s`, { size: 22, font: MONO, anchor: 'middle', fill: C.dim })}`;
  }).join('');
  return frame({
    n: 2,
    label: 'The RINSE',
    title: ['A 90% fee that washes', 'out in 27 seconds.'],
    body: `<line x1="96" y1="${base}" x2="1504" y2="${base}" stroke="${C.line}" stroke-width="2"/>
      ${bars}
      ${t(1504, 400, 'Sniper at 0s pays 90%', { size: 32, font: HEAVY, weight: 900, fill: C.red, anchor: 'end' })}
      ${t(1504, 446, 'Patient buyer at 27s pays ~1.25%', { size: 32, font: HEAVY, weight: 900, fill: C.green, anchor: 'end' })}
      ${t(1504, 488, 'Steps down every 3 seconds · dynamic fees disabled', { size: 24, fill: C.muted, anchor: 'end' })}`,
  });
};

// ---------- 03 creator first buy ----------
const creatorBuy = () => {
  const stats = [
    ['Optional', 'Skip it entirely if you want'],
    ['Up to 2%', 'Of total supply, never more'],
    ['1.25%', 'Floor fee, not the 90% RINSE'],
  ];
  const segment = 1408 * 0.02;
  return frame({
    n: 3,
    label: 'Fair start',
    title: ['A fair first buy', 'for creators.'],
    body: `${t(96, 400, 'Creator first buy', { size: 30, font: HEAVY, weight: 900, fill: C.cyan })}
      ${t(96, 436, 'up to 2% of supply', { size: 24, fill: C.muted })}
      <path d="M${96 + segment / 2} 452 V 484" stroke="${C.cyan}" stroke-width="3" stroke-linecap="round"/>
      <rect x="96" y="484" width="1408" height="84" rx="14" fill="${C.surface}" stroke="${C.line}" stroke-width="2"/>
      <clipPath id="bar"><rect x="96" y="484" width="1408" height="84" rx="14"/></clipPath>
      <rect x="96" y="484" width="${segment}" height="84" fill="${C.cyan}" clip-path="url(#bar)"/>
      <line x1="${96 + segment}" y1="484" x2="${96 + segment}" y2="568" stroke="${C.cyan}" stroke-width="3"/>
      ${t(800, 538, '98% left for the market', { size: 30, font: SEMI, weight: 600, fill: C.muted, anchor: 'middle' })}
      ${stats
        .map(([v, c], i) => {
          const x = 96 + i * 484;
          return `${box(x, 618, 440, 150)}
            ${t(x + 36, 690, v, { size: 46, font: HEAVY, weight: 900, fill: i === 2 ? C.green : C.text })}
            ${t(x + 36, 732, c, { size: 24, fill: C.muted })}`;
        })
        .join('')}`,
  });
};

// ---------- 04 launch checks ----------
const checks = () => {
  const items = [
    ['Ticker reused', 'within the past hour'],
    ['Ticker already bonded', 'here on rinsed.fun'],
    ['Lookalike names', 'close copies of live coins'],
    ['Similar artwork', 'reused or near-identical images'],
    ['Reused X source post', 'one post, one launch'],
    ['Ticker trading elsewhere', 'with at least $10,000 liquidity'],
  ];
  return frame({
    n: 4,
    label: 'Launch checks',
    title: ['Copycats get stopped', 'at the door.'],
    body: items
      .map(([head, sub], i) => {
        const x = 96 + (i % 3) * 484;
        const y = 360 + Math.floor(i / 3) * 210;
        return `${box(x, y, 440, 180)}
          ${iconCircle(x + 66, y + 66, 30, C.red, ICON.block)}
          ${t(x + 404, y + 56, `0${i + 1}`, { size: 22, font: MONO, fill: C.dim, anchor: 'end' })}
          ${t(x + 36, y + 136, head, { size: 30, font: HEAVY, weight: 900 })}
          ${t(x + 36, y + 166, sub, { size: 22, fill: C.muted })}`;
      })
      .join(''),
  });
};

// ---------- 05 buyback and burn ----------
const buyback = () => {
  const nodes = [
    ['coins', 'RINSE fees', 'collected from trades', C.pink],
    ['cycle', 'Budget fills', 'to at least 0.025 SOL', C.violet],
    ['chart', 'Buyback', 'executed on-chain', C.cyan],
    ['flame', 'Burn', 'bought tokens burned', C.amber],
  ];
  const w = 300, gap = (1408 - 4 * w) / 3;
  return frame({
    n: 5,
    label: 'Where the RINSE goes',
    title: ['Fees fund buybacks', 'and burns.'],
    body: `${nodes
      .map(([icon, head, sub, color], i) => {
        const x = 96 + i * (w + gap);
        const arrow =
          i < 3
            ? `<path d="M${x + w + 14} 500 h${gap - 34}" stroke="${C.dim}" stroke-width="3"/><path d="M${x + w + gap - 26} 490 l12 10 -12 10" stroke="${C.dim}" stroke-width="3" fill="none"/>`
            : '';
        const ring =
          i === 1
            ? `<circle cx="${x + w / 2}" cy="436" r="54" fill="none" stroke="${C.line}" stroke-width="8"/>
               <circle cx="${x + w / 2}" cy="436" r="54" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${2 * Math.PI * 54 * 0.72} 999" transform="rotate(-90 ${x + w / 2} 436)"/>`
            : '';
        return `${box(x, 360, w, 280)}${ring}
          ${i === 1 ? `<g transform="translate(${x + w / 2} 436)" stroke="${color}" fill="none" stroke-width="3.5" stroke-linecap="round">${ICON[icon]}</g>` : iconCircle(x + w / 2, 436, 46, color, ICON[icon])}
          ${t(x + w / 2, 550, head, { size: 34, font: HEAVY, weight: 900, anchor: 'middle' })}
          ${t(x + w / 2, 590, sub, { size: 23, fill: C.muted, anchor: 'middle' })}${arrow}`;
      })
      .join('')}
      ${box(96, 676, 1408, 90, { fill: C.green, stroke: C.green, opacity: 0.08 })}
      <rect x="96" y="676" width="1408" height="90" rx="20" fill="none" stroke="${C.green}" stroke-opacity="0.4" stroke-width="2"/>
      ${iconCircle(150, 721, 26, C.green, ICON.receipt.replace(/-20/g, '-14').replace(/20/g, '14'))}
      ${t(196, 731, 'Every buyback and every burn has a verifiable on-chain receipt.', { size: 28, font: SEMI, weight: 600, fill: C.green })}`,
  });
};

// ---------- 06 modes ----------
const modes = () => {
  const card = (x, color, icon, head, lines) => `${box(x, 400, 680, 300)}
    ${iconCircle(x + 80, 480, 42, color, ICON[icon])}
    ${t(x + 144, 470, head, { size: 40, font: HEAVY, weight: 900 })}
    ${t(x + 144, 504, 'after the RINSE', { size: 22, fill: C.dim })}
    ${lines.map((l, i) => `<circle cx="${x + 56}" cy="${582 + i * 50}" r="6" fill="${color}"/>${t(x + 80, 591 + i * 50, l, { size: 28, fill: C.text })}`).join('')}`;
  return frame({
    n: 6,
    label: 'After the RINSE',
    title: ['Creator mode or', 'Community mode.'],
    body: `${pillRow(96, 328, [['1  Launch', C.muted], ['2  RINSE 90% → 1.25%', C.pink], ['3  Your mode takes over', C.cyan]], 18)}
      ${card(96, C.violet, 'person', 'Creator mode', ['Creator rewards', 'Mode is fixed once the launch confirms'])}
      ${card(824, C.cyan, 'group', 'Community mode', ['Hourly holder snapshots', 'Claimable SOL for eligible holders'])}
      ${t(96, 752, 'Paid from fees actually collected, after protocol and any referral fees, with a share kept for platform operations.', { size: 22, fill: C.muted })}
      ${t(96, 784, 'Network costs are separate. No promised APY.', { size: 22, fill: C.muted })}`,
  });
};

// ---------- 07 graduation ----------
const graduation = () => {
  const x0 = 96, x1 = 1000, y = 500;
  const ticks = [0, 20, 40, 60, 80]
    .map((v) => {
      const x = x0 + ((x1 - x0) * v) / 80;
      return `<line x1="${x}" y1="${y + 74}" x2="${x}" y2="${y + 86}" stroke="${C.dim}" stroke-width="2"/>${t(x, y + 118, `${v} SOL`, { size: 22, font: MONO, fill: C.dim, anchor: v === 0 ? 'start' : v === 80 ? 'end' : 'middle' })}`;
    })
    .join('');
  return frame({
    n: 7,
    label: 'Graduation',
    title: ['Graduation with liquidity', 'nobody can pull.'],
    body: `${t(x0, 450, 'Bonding curve reserves', { size: 28, font: SEMI, weight: 600, fill: C.muted })}
      ${t(x1, 450, '80 SOL target', { size: 28, font: HEAVY, weight: 900, fill: C.cyan, anchor: 'end' })}
      <rect x="${x0}" y="${y - 30}" width="${x1 - x0}" height="64" rx="32" fill="${C.surface}" stroke="${C.line}" stroke-width="2"/>
      <rect x="${x0 + 8}" y="${y - 22}" width="${x1 - x0 - 16}" height="48" rx="24" fill="url(#brand)"/>
      ${ticks}
      <path d="M1030 500 h70" stroke="${C.dim}" stroke-width="4"/><path d="M1090 486 l16 14 -16 14" stroke="${C.dim}" stroke-width="4" fill="none"/>
      ${box(1130, 370, 374, 300, { stroke: C.green })}
      ${iconCircle(1317, 450, 46, C.green, ICON.lock)}
      ${t(1317, 548, 'Meteora DAMM v2', { size: 34, font: HEAVY, weight: 900, anchor: 'middle' })}
      ${t(1317, 590, 'Launchpad liquidity', { size: 24, fill: C.muted, anchor: 'middle' })}
      ${t(1317, 624, 'permanently locked', { size: 26, font: SEMI, weight: 600, fill: C.green, anchor: 'middle' })}
      ${pillRow(96, 690, [['1  Curve fills to 80 SOL', C.violet], ['2  Coin migrates to DAMM v2', C.cyan], ['3  Liquidity locked for good', C.green]], 18)}`,
  });
};

// ---------- 08 RINSED Terminal ----------
const terminal = () => {
  // Deterministic illustrative candles for the mock chart.
  let seed = 11, price = 200;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const candles = Array.from({ length: 42 }, () => {
    const open = price;
    const close = Math.max(60, open + (rand() - 0.4) * 70);
    price = close;
    return { open, close, high: Math.max(open, close) + rand() * 14, low: Math.min(open, close) - rand() * 14, vol: 8 + rand() * 34 };
  });
  const lo = Math.min(...candles.map((c) => c.low)), hi = Math.max(...candles.map((c) => c.high));
  const cx0 = 120, cw = 960, cy0 = 470, ch = 230;
  const py = (v) => cy0 + ch - ((v - lo) / (hi - lo)) * ch;
  const step = cw / candles.length;
  const chart = candles
    .map((c, i) => {
      const x = cx0 + i * step + step / 2;
      const up = c.close >= c.open;
      const color = up ? C.green : C.red;
      return `<line x1="${x}" y1="${py(c.high)}" x2="${x}" y2="${py(c.low)}" stroke="${color}" stroke-width="2"/>
        <rect x="${x - step * 0.32}" y="${Math.min(py(c.open), py(c.close))}" width="${step * 0.64}" height="${Math.max(Math.abs(py(c.open) - py(c.close)), 2)}" rx="2" fill="${color}"/>
        <rect x="${x - step * 0.32}" y="${760 - c.vol}" width="${step * 0.64}" height="${c.vol}" fill="${color}" opacity="0.3"/>`;
    })
    .join('');
  const last = candles[candles.length - 1].close;
  const stats = [['MCAP', '$48.2K'], ['24H VOL', '$31.6K'], ['HOLDERS', '412'], ['BONDING', '61%']];
  const rx = 1110;
  return frame({
    n: 8,
    label: 'RINSED Terminal',
    title: ['RINSED Terminal.'],
    sub: 'Find, check and trade a coin from one screen inside the launchpad.',
    body: `${box(96, 330, 1408, 460, { fill: C.panel })}
      <circle cx="140" cy="374" r="22" fill="url(#brand)"/>
      ${t(176, 368, 'Soapy Frog', { size: 24, font: SEMI, weight: 600 })}${t(176, 394, '$SOAP · sample', { size: 18, font: MONO, fill: C.dim })}
      ${stats.map(([k, v], i) => `${t(470 + i * 150, 362, k, { size: 15, font: SEMI, weight: 600, fill: C.dim, ls: 1.5 })}${t(470 + i * 150, 392, v, { size: 24, font: MONO, fill: C.text })}`).join('')}
      <rect x="1070" y="384" width="0" height="0"/>
      <line x1="96" y1="418" x2="1504" y2="418" stroke="${C.line}" stroke-width="2"/>
      <line x1="${rx - 16}" y1="418" x2="${rx - 16}" y2="790" stroke="${C.line}" stroke-width="2"/>
      ${['1s', '5s', '15s', '1m', '5m', '1h'].map((s, i) => `${i === 1 ? `<rect x="${118 + i * 52}" y="430" width="44" height="28" rx="6" fill="${C.line}"/>` : ''}${t(140 + i * 52, 451, s, { size: 17, font: MONO, anchor: 'middle', fill: i === 1 ? C.text : C.dim })}`).join('')}
      ${chart}
      <line x1="${cx0}" y1="${py(last)}" x2="${cx0 + cw}" y2="${py(last)}" stroke="${C.green}" stroke-dasharray="4 6" stroke-width="1.5"/>
      <rect x="${rx}" y="430" width="380" height="40" rx="8" fill="${C.green}" fill-opacity="0.1"/>
      ${t(rx + 16, 456, 'RINSE OVER', { size: 16, font: SEMI, weight: 600, fill: C.green, ls: 1.5 })}${t(rx + 364, 457, '1.25%', { size: 20, font: MONO, fill: C.green, anchor: 'end' })}
      <rect x="${rx}" y="484" width="380" height="48" rx="10" fill="${C.surface}"/>
      <rect x="${rx + 4}" y="488" width="186" height="40" rx="8" fill="${C.green}"/>
      ${t(rx + 97, 515, 'Buy', { size: 20, font: SEMI, weight: 600, fill: '#0E1424', anchor: 'middle' })}${t(rx + 285, 515, 'Sell', { size: 20, font: SEMI, weight: 600, fill: C.muted, anchor: 'middle' })}
      ${box(rx, 544, 380, 76, { r: 12, fill: C.surface })}
      ${t(rx + 16, 568, 'You pay', { size: 15, fill: C.dim })}${t(rx + 16, 604, '0.50', { size: 30, font: MONO, fill: C.text })}${t(rx + 364, 602, 'SOL', { size: 18, font: SEMI, weight: 600, anchor: 'end' })}
      ${['0.1', '0.5', '1', '2'].map((s, i) => `${box(rx + i * 97, 632, 89, 36, { r: 8, fill: 'none', stroke: i === 1 ? C.green : C.line })}${t(rx + i * 97 + 44, 656, `${s} SOL`, { size: 15, font: MONO, anchor: 'middle', fill: i === 1 ? C.green : C.muted })}`).join('')}
      <rect x="${rx}" y="678" width="380" height="34" rx="8" fill="${C.green}" fill-opacity="0.08" stroke="${C.green}" stroke-opacity="0.45"/>${t(rx + 14, 701, 'Fee shown before you sign', { size: 16, font: SEMI, weight: 600, fill: C.green })}${t(rx + 366, 701, '1.25%', { size: 17, font: MONO, anchor: 'end', fill: C.green })}
      <rect x="${rx}" y="726" width="380" height="48" rx="10" fill="${C.green}"/>
      ${t(rx + 190, 757, 'Buy SOAP', { size: 21, font: SEMI, weight: 600, fill: '#0E1424', anchor: 'middle' })}
      ${pill(140, 486, 'Live on-chain chart', C.cyan, 17)}`,
  });
};

// ---------- 09 verify ----------
const verify = () => {
  const receipts = [
    ['flame', 'Burn completed', C.amber],
    ['chart', 'Buyback executed', C.cyan],
    ['receipt', 'Holder payout sent', C.violet],
  ];
  return frame({
    n: 9,
    label: 'Verify',
    title: ['Don’t trust.', 'Verify.'],
    body: `${receipts
      .map(([icon, head, color], i) => {
        const y = 370 + i * 132;
        return `${box(96, y, 680, 112)}
          ${iconCircle(156, y + 56, 30, color, ICON[icon])}
          ${t(206, y + 50, head, { size: 30, font: HEAVY, weight: 900 })}
          ${t(206, y + 84, 'on-chain receipt · anyone can check it', { size: 22, fill: C.muted })}
          ${t(744, y + 66, 'Explorer ↗', { size: 22, font: SEMI, weight: 600, fill: C.cyan, anchor: 'end' })}`;
      })
      .join('')}
      ${box(840, 370, 664, 376, { stroke: C.amber })}
      ${iconCircle(904, 434, 30, C.amber, ICON.warn)}
      ${t(954, 444, 'Straight talk', { size: 32, font: HEAVY, weight: 900, fill: C.amber })}
      ${['These checks and fees discourage', 'abuse. They can’t eliminate bots,', 'bundling or copies.'].map((l, i) => t(880, 520 + i * 40, l, { size: 28, fill: C.text })).join('')}
      ${t(880, 660, 'Enough rugging.', { size: 40, font: HEAVY, weight: 900 })}
      <text x="880" y="712" font-family="${HEAVY}" font-size="40" font-weight="900" fill="url(#brand)">Time to get rinsed.</text>`,
  });
};

const images = {
  '00-banner': banner,
  '01-trenches': trenches,
  '02-rinse-fee': rinse,
  '03-creator-buy': creatorBuy,
  '04-launch-checks': checks,
  '05-buyback-burn': buyback,
  '06-modes': modes,
  '07-graduation': graduation,
  '08-terminal': terminal,
  '09-verify': verify,
};
const only = process.argv[2];
for (const [name, build] of Object.entries(images)) {
  if (only && !name.startsWith(only)) continue;
  const svg = build();
  writeFileSync(join(out, `${name}.svg`), svg);
  await sharp(Buffer.from(svg), { density: 72 }).png({ compressionLevel: 9 }).toFile(join(out, `${name}.png`));
  console.log('rendered', name);
}
