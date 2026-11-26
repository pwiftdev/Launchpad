import { apiGuard } from '@/server/apiGuard';
// Share card for a coin (1200x630), used as og:image / twitter:image on /token/[mint].
// A pages API route on the Node runtime, so it can use sharp and the server data layer.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { ImageResponse } from 'next/og';
import sharp from 'sharp';
import { parseKey, chainTime } from '@/server/dbc';
import { displayStore } from '@/server/display';
import { getSolPrice } from '@/server/solPrice';
import { taxStateAt, formatTaxPercent, hasCurrentTaxSchedule } from '@/lib/launchTax';
import { BRAND } from '@/constants/brand';
import { tokenImages } from '@/server/tokenImageCache';

const W = 1200;
const H = 630;

type Font = { name: string; data: ArrayBuffer; weight: 400 | 500 | 700 | 900; style: 'normal' };
let fontsPromise: Promise<Font[]> | null = null;

/** Geist Mono + Geist from Google Fonts (TTF is served when no browser user agent is sent). */
function loadFonts(): Promise<Font[]> {
  fontsPromise ??= (async () => {
    const load = async (family: string, weight: Font['weight']): Promise<Font | null> => {
      try {
        const css = await (
          await fetch(
            `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}:wght@${weight}`,
            {
              signal: AbortSignal.timeout(4000),
            }
          )
        ).text();
        const url = css.match(/src: url\((.+?)\) format\('(?:truetype|opentype)'\)/)?.[1];
        if (!url) return null;
        const data = await (await fetch(url, { signal: AbortSignal.timeout(4000) })).arrayBuffer();
        return { name: family, data, weight, style: 'normal' };
      } catch {
        return null;
      }
    };
    const fonts = await Promise.all([
      load('Geist Mono', 500),
      load('Geist Mono', 700),
      load('Geist', 500),
      load('Geist', 700),
    ]);
    return fonts.filter((f): f is Font => f !== null);
  })();
  return fontsPromise;
}

let logoPromise: Promise<string> | null = null;
const loadLogo = () =>
  (logoPromise ??= readFile(path.join(process.cwd(), 'public', BRAND.assets.markPng.slice(1))).then(
    (png) => `data:image/png;base64,${png.toString('base64')}`
  ));
let wordmarkPromise: Promise<string> | null = null;
const loadWordmark = () =>
  (wordmarkPromise ??= readFile(
    path.join(process.cwd(), 'public', BRAND.assets.wordmarkPng.slice(1))
  ).then((png) => `data:image/png;base64,${png.toString('base64')}`));

/** Coin image as a small PNG data URI (IPFS can be slow; never let it hang the card). */
async function coinImage(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const png = await sharp((await tokenImages.get(url)).bytes, {
      limitInputPixels: 16_777_216,
    })
      .resize(240, 240, { fit: 'cover' })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return null;
  }
}

const usd = (v: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: v >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: v >= 10_000 ? 1 : 2,
  }).format(v);

/** GET /api/og/[mint] -> PNG share card. Anything that is not one of our coins gets the brand card. */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') {
    res.status(405).end();
    return;
  }
  try {
    const image = await renderCard(String(req.query.mint ?? ''));
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(Buffer.from(await image.arrayBuffer()));
  } catch (error) {
    console.error('OG card error:', error);
    res.status(500).end();
  }
}

const C = BRAND.colors;
const TEXT = '#fafafa';
const MUTED = '#8c8c8c';
const DIM = '#4d4d4d';
const LINE = '#262626';
// Dot matrix + a faint signal glow, the same texture as the app background
const GRID = `radial-gradient(circle, rgba(255,255,255,0.09) 1.5px, transparent 1.6px)`;
const GLOW = `radial-gradient(circle at 82% 40%, rgba(255,102,0,0.14), transparent 46%)`;
const BOND = `linear-gradient(90deg, #4d4d4d, #fafafa 58%, ${C.orange})`;

/** Hairline frame with corner ticks, like a terminal viewport */
const Frame = () => (
  <div
    style={{
      position: 'absolute',
      left: 28,
      top: 28,
      right: 28,
      bottom: 28,
      display: 'flex',
      border: `1px solid ${LINE}`,
    }}
  >
    {[
      { left: -1, top: -1, borderLeft: 3, borderTop: 3 },
      { right: -1, top: -1, borderRight: 3, borderTop: 3 },
      { left: -1, bottom: -1, borderLeft: 3, borderBottom: 3 },
      { right: -1, bottom: -1, borderRight: 3, borderBottom: 3 },
    ].map((corner, i) => (
      <div
        key={i}
        style={{
          position: 'absolute',
          width: 22,
          height: 22,
          display: 'flex',
          borderColor: C.orange,
          borderStyle: 'solid',
          borderWidth: 0,
          ...Object.fromEntries(
            Object.entries(corner).map(([k, v]) => [k.startsWith('border') ? `${k}Width` : k, v])
          ),
        }}
      />
    ))}
  </div>
);

async function renderCard(mint: string): Promise<ImageResponse> {
  const key = parseKey(mint);
  const indexed = key
    ? await displayStore()
        ?.coin(key.toBase58())
        .catch((): null => null)
    : null;
  const activity = indexed ? { coin: indexed } : null;
  const [fonts, logo, wordmark] = await Promise.all([loadFonts(), loadLogo(), loadWordmark()]);
  const term = fonts.some((f) => f.name === 'Geist Mono') ? 'Geist Mono' : undefined;
  const body = fonts.some((f) => f.name === 'Geist') ? 'Geist' : undefined;
  const base = {
    width: W,
    height: H,
    display: 'flex',
    flexDirection: 'column' as const,
    position: 'relative' as const,
    overflow: 'hidden' as const,
    backgroundColor: C.background,
    backgroundImage: `${GLOW}, ${GRID}`,
    backgroundSize: `100% 100%, 26px 26px`,
    color: TEXT,
    fontFamily: body,
  };

  if (!activity) {
    return new ImageResponse(
      <div style={{ ...base, padding: '76px 84px' }}>
        <Frame />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logo}
          width={430}
          height={430}
          alt=""
          style={{ position: 'absolute', right: 70, top: 100 }}
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={wordmark} width={500} height={99} alt={BRAND.name} />
        <div
          style={{
            display: 'flex',
            marginTop: 40,
            fontSize: 20,
            letterSpacing: 4,
            color: C.orange,
            fontFamily: term,
            fontWeight: 700,
          }}
        >
          {'> THE MONERO PAYOUT LAUNCHPAD'}
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            marginTop: 16,
            // Fits the two headline lines left of the mask artwork.
            fontSize: 56,
            fontFamily: term,
            fontWeight: 700,
            lineHeight: 1.05,
            letterSpacing: -2,
          }}
        >
          <span>{BRAND.headline.top}</span>
          <span style={{ color: C.orange }}>{BRAND.headline.bottom}</span>
        </div>
        <div
          style={{ display: 'flex', marginTop: 26, fontSize: 24, fontFamily: term, color: MUTED }}
        >
          {BRAND.promise.map((p, i) => (
            <span key={p} style={{ display: 'flex' }}>
              {i > 0 && <span style={{ color: DIM, margin: '0 14px' }}>/</span>}
              {p.toUpperCase()}
            </span>
          ))}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 'auto',
            fontSize: 22,
            fontFamily: term,
          }}
        >
          <span style={{ color: MUTED }}>{BRAND.xHandle}</span>
          <span
            style={{
              display: 'flex',
              padding: '6px 14px',
              backgroundColor: C.orange,
              color: '#000',
              fontWeight: 700,
            }}
          >
            ${BRAND.ticker}
          </span>
        </div>
      </div>,
      { width: W, height: H, fonts }
    );
  }

  const { coin } = activity;
  const price = await getSolPrice();
  const sol = (v: number) => (price ? usd(v * price.usd) : `${v.toFixed(2)} SOL`);
  const image = await coinImage(coin.image);
  const tax = hasCurrentTaxSchedule(coin)
    ? taxStateAt((await chainTime()) - coin.launchedAt, coin.isMigrated)
    : null;
  const progress = coin.isMigrated ? 1 : Math.min(Math.max(coin.progress, 0), 1);
  const status = coin.isMigrated
    ? { text: 'BONDED', color: C.orange }
    : !tax
      ? { text: 'LIVE · SEE QUOTE FOR FEES', color: TEXT }
      : tax.isClean
        ? progress >= 0.8
          ? { text: `${(progress * 100).toFixed(0)}% TO BOND`, color: C.orange }
          : { text: `LIVE · ${(progress * 100).toFixed(1)}% TO BOND`, color: TEXT }
        : { text: `SNIPE TAX ${formatTaxPercent(tax.percent)}`, color: C.down };

  const stats = [
    { label: 'Market cap', value: sol(coin.marketCapSol), color: TEXT },
    {
      label: coin.isMigrated ? 'Status' : 'Curve reserves',
      value: coin.isMigrated ? 'BONDED' : sol(coin.quoteReserveSol),
      color: coin.isMigrated ? C.orange : TEXT,
    },
    {
      label: 'Trading fee',
      value: tax ? formatTaxPercent(tax.percent) : 'See quote',
      color: TEXT,
    },
  ];
  const shown = Math.max(progress * 100, progress > 0 ? 3 : 0);

  return new ImageResponse(
    <div style={{ ...base, padding: '68px 84px 60px' }}>
      <Frame />
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <div style={{ display: 'flex', padding: 3, backgroundColor: C.orange }}>
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} width={158} height={158} alt="" />
          ) : (
            <div
              style={{
                width: 158,
                height: 158,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: '#000',
                color: C.orange,
                fontSize: 80,
                fontWeight: 700,
                fontFamily: term,
              }}
            >
              {coin.symbol.slice(0, 1).toUpperCase()}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', marginLeft: 40, flex: 1 }}>
          <div
            style={{
              display: 'flex',
              fontSize: 66,
              fontWeight: 700,
              fontFamily: term,
              lineHeight: 1,
              letterSpacing: -2,
            }}
          >
            ${coin.symbol}
          </div>
          <div style={{ display: 'flex', fontSize: 30, color: MUTED, marginTop: 14 }}>
            {coin.name.length > 34 ? `${coin.name.slice(0, 33)}…` : coin.name}
          </div>
          <div
            style={{
              display: 'flex',
              marginTop: 20,
              alignSelf: 'flex-start',
              padding: '7px 14px',
              border: `2px solid ${status.color}`,
              color: status.color,
              fontSize: 20,
              fontFamily: term,
              fontWeight: 700,
              letterSpacing: 1,
            }}
          >
            {`> ${status.text}`}
          </div>
        </div>
      </div>

      {/* Bonding progress */}
      <div style={{ display: 'flex', flexDirection: 'column', marginTop: 38 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 19,
            fontFamily: term,
            fontWeight: 700,
            letterSpacing: 2,
            color: MUTED,
          }}
        >
          <span>BONDING PROGRESS</span>
          <span style={{ color: progress >= 0.8 ? C.orange : TEXT }}>
            {(progress * 100).toFixed(1)}%
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            marginTop: 10,
            height: 18,
            backgroundColor: '#1c1c1c',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'flex',
              width: `${shown}%`,
              height: '100%',
              backgroundImage: BOND,
              backgroundSize: `${(100 / Math.max(shown, 1)) * 100}% 100%`,
            }}
          />
        </div>
      </div>

      <div style={{ display: 'flex', marginTop: 32 }}>
        {stats.map((s, i) => (
          <div
            key={s.label}
            style={{
              display: 'flex',
              flexDirection: 'column',
              flex: 1,
              paddingLeft: i === 0 ? 0 : 36,
              borderLeft: i === 0 ? 'none' : `1px solid ${LINE}`,
            }}
          >
            <div
              style={{
                display: 'flex',
                fontSize: 18,
                color: MUTED,
                letterSpacing: 2,
                textTransform: 'uppercase',
                fontFamily: term,
                fontWeight: 700,
              }}
            >
              {s.label}
            </div>
            <div
              style={{
                display: 'flex',
                fontSize: 46,
                fontWeight: 700,
                color: s.color,
                marginTop: 6,
              }}
            >
              {s.value}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', marginTop: 'auto' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logo} width={52} height={52} alt="" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={wordmark} width={196} height={39} style={{ marginLeft: 14 }} alt={BRAND.name} />
        <div
          style={{
            display: 'flex',
            marginLeft: 'auto',
            fontSize: 24,
            fontFamily: term,
            color: MUTED,
          }}
        >
          {BRAND.headline.top}&nbsp;
          <span style={{ color: C.orange }}>{BRAND.headline.bottom}</span>
        </div>
      </div>
    </div>,
    { width: W, height: H, fonts }
  );
}
