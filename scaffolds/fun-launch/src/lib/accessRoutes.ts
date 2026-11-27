import { BRAND } from '@/constants/brand';
import bs58 from 'bs58';

/** Server runtime switch: neither a browser variable nor a build-time default opens admission. */
export function launchpadIsPublic(): boolean {
  return process.env.LAUNCHPAD_PUBLIC === 'true';
}

/** Public surfaces are allowlisted. Unknown routes always require an admin session. */
export function accessPath(url: string): string {
  const path = (url.split('?')[0] ?? '').replace(/\/+$/, '') || '/';
  // Next normally normalizes data requests before middleware; also handle their raw form.
  const data = path.match(/^\/_next\/data\/[^/]+\/(.+)\.json$/);
  return data ? (data[1] === 'index' ? '/' : `/${data[1]}`) : path;
}

const LAUNCHPAD_APIS = [
  '/api/coins',
  '/api/trending',
  '/api/market-stats',
  '/api/solana-market',
  '/api/sol-price',
  '/api/token-image',
  '/api/quote',
  '/api/swap-tx',
  '/api/send-transaction',
  '/api/transaction-status',
  '/api/rewards',
  '/api/earnings',
  '/api/proof',
  '/api/proof/key-images',
  '/api/live',
  '/api/upload',
  '/api/dev-buy-quote',
  '/api/launch/status',
  '/api/launch/confirm',
  '/api/launch/receipt-status',
  '/api/launch/migrate',
  '/api/launch/confirm-migration',
] as const;
const DEMO_ARTWORK = new Set(
  [
    'bubble-cat',
    'cactus-club',
    'cloud-bunny',
    'cosmic-capy',
    'disco-shrimp',
    'honey-bear',
    'jelly-jam',
    'lucky-lobster',
    'mango-moth',
    'mint-otter',
    'moon-duck',
    'neon-newt',
    'noodle-dragon',
    'orbit-owl',
    'peach-panda',
    'pixel-pigeon',
    'rinse-frog',
    'rocket-raccoon',
    'sleepy-sun',
    'soap-dog',
    'soda-sloth',
    'sushi-shark',
    'tiny-whale',
    'turbo-turtle',
    'velvet-fox',
  ].map((slug) => `/demo/coins/${slug}.webp`)
);
function mintAddress(value: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

/** A Solana transaction signature: base58 of 64 bytes. */
export function transactionSignature(value: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value)) return false;
  try {
    return bs58.decode(value).length === 64;
  } catch {
    return false;
  }
}

/** Only actual launchpad documents qualify for the renderer's admin bypass. */
export function launchpadPage(url: string): boolean {
  const path = accessPath(url);
  if (['/', '/launch', '/earnings', '/proof', '/rules', '/roadmap', '/404'].includes(path))
    return true;
  const token = path.match(/^\/token\/([^/]+)$/);
  const burn = path.match(/^\/proof\/burn\/([^/]+)$/);
  return (!!token && mintAddress(token[1]!)) || (!!burn && transactionSignature(burn[1]!));
}

export function publicApi(url: string, open = launchpadIsPublic()): boolean {
  const path = accessPath(url);
  if (
    [
      '/api/admin/session',
      '/api/health',
      '/api/og/brand',
      '/api/og/plzzz',
      '/api/og/rinsed',
    ].includes(path)
  )
    return true;
  if (!open) return false;
  if ((LAUNCHPAD_APIS as readonly string[]).includes(path)) return true;
  const coin = path.match(/^\/api\/coins\/([^/]+)(?:\/(?:trades|holders|live|balance))?$/);
  const og = path.match(/^\/api\/og\/([^/]+)$/);
  const burn = path.match(/^\/api\/proof\/burns\/([^/]+)$/);
  return (
    (!!coin && mintAddress(coin[1]!)) ||
    (!!og && mintAddress(og[1]!)) ||
    (!!burn && transactionSignature(burn[1]!))
  );
}

export function publicPage(url: string, open = launchpadIsPublic()): boolean {
  const path = accessPath(url);
  return (
    ['/privacy', '/admin', '/logo.svg', '/favicon.ico', '/site.webmanifest'].includes(path) ||
    (Object.values(BRAND.assets) as readonly string[]).includes(path) ||
    (open && (launchpadPage(path) || path === '/coins/unknown.svg' || DEMO_ARTWORK.has(path)))
  );
}
