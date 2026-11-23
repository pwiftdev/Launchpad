// Server-only: anti-vamp checks that run before a launch transaction is built.
import { normalizeTicker } from '@/lib/antivamp/normalizeTicker';
import { findNameCopy, hashDistance, parseSourcePost } from '@/lib/antivamp/rules';
import {
  ANTIVAMP_IMAGE_DISTANCE,
  ANTIVAMP_MIN_LIQUIDITY_USD,
  ANTIVAMP_RECENT_MINUTES,
} from '@/constants/launch';
import type { Coin } from '@/lib/coin';
import { cachedMeta, listCoins } from './dbc';
import { imageHash, remoteImageHash } from './imageHash';

const MIN_LIQUIDITY_USD =
  Number(process.env.ANTIVAMP_MIN_LIQUIDITY_USD) || ANTIVAMP_MIN_LIQUIDITY_USD;
const IMAGE_DISTANCE = Number(process.env.ANTIVAMP_IMAGE_DISTANCE) || ANTIVAMP_IMAGE_DISTANCE;
// Bound the image comparison to the coins most likely to be copied
const IMAGE_COMPARE_LIMIT = 300;
// Owner-authorized reuse of TESTDROP's test artwork for the official project token.
// This exception applies only to image comparisons, never names, tickers or source posts.
const IMAGE_REFERENCE_EXCLUSIONS = new Set(['J21qHBjC2mLQbHL9TQhXBxNn52ViwhgXSKL8urbWMxsq']);

export type LaunchInput = {
  name: string;
  symbol: string;
  sourceUrl?: string;
  /** Omit for the live pre-check while typing; the launch itself always includes it */
  image?: Buffer;
};

export type Rejection = { field: 'name' | 'ticker' | 'image' | 'source'; error: string };

const minutesAgo = (unix: number) => Math.max(Math.round((Date.now() / 1000 - unix) / 60), 0);

/** Ticker launched here in the last hour, or bonded here at any time. */
function tickerRule(ticker: string, coins: Coin[]): Rejection | null {
  const clash = coins.find(
    (c) =>
      normalizeTicker(c.symbol) === ticker &&
      (c.isMigrated ||
        c.launchedAt <= 0 ||
        Date.now() / 1000 - c.launchedAt < ANTIVAMP_RECENT_MINUTES * 60)
  );
  if (!clash) return null;
  return {
    field: 'ticker',
    error: clash.isMigrated
      ? `$${clash.symbol} already bonded on MSKD.fun. Pick a different ticker.`
      : clash.launchedAt <= 0
        ? `$${clash.symbol} is already used by an existing launch. Pick a different ticker.`
        : `$${clash.symbol} launched here ${minutesAgo(clash.launchedAt)} min ago. The same ticker is blocked for ${ANTIVAMP_RECENT_MINUTES} minutes.`,
  };
}

/** An existing coin's name plus "official", "real", "2", "v2" and similar. */
function nameRule(name: string, coins: Coin[]): Rejection | null {
  const copied = findNameCopy(
    name,
    coins.map((c) => c.name)
  );
  return copied
    ? {
        field: 'name',
        error: `"${name}" looks like a copy of ${copied}. Launch something original.`,
      }
    : null;
}

type DexPair = {
  chainId: string;
  dexId: string;
  baseToken: { symbol: string; name: string };
  liquidity?: { usd?: number };
};

/** Ticker already trading elsewhere with real liquidity (DexScreener, any chain). */
async function marketRule(ticker: string): Promise<Rejection | null> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(ticker)}`,
      { signal: AbortSignal.timeout(4000) }
    );
    if (!res.ok) return null;
    const { pairs } = (await res.json()) as { pairs?: DexPair[] };
    const live = (pairs ?? [])
      .filter((p) => normalizeTicker(p.baseToken.symbol) === ticker)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    if (!live || (live.liquidity?.usd ?? 0) < MIN_LIQUIDITY_USD) return null;
    const liquidity = Math.round(live.liquidity!.usd!).toLocaleString('en-US');
    return {
      field: 'ticker',
      error: `$${live.baseToken.symbol} already trades on ${live.dexId} (${live.chainId}) with $${liquidity} liquidity. No vamps.`,
    };
  } catch {
    // DexScreener unreachable: don't block launches on a third-party outage
    return null;
  }
}

/** One launch per source post on X. */
function sourceRule(postId: string, coins: Coin[]): Rejection | null {
  const used = coins.find((c) => {
    const source = cachedMeta(c.mint)?.source;
    return source ? parseSourcePost(source) === postId : false;
  });
  return used
    ? { field: 'source', error: `That post was already used to launch $${used.symbol}.` }
    : null;
}

/** Image within IMAGE_DISTANCE bits of an existing coin's image. */
async function imageRule(image: Buffer, coins: Coin[]): Promise<Rejection | null> {
  let hash: string;
  try {
    hash = await imageHash(image);
  } catch {
    return { field: 'image', error: 'That image could not be read. Use a PNG, JPG, GIF or WebP.' };
  }
  const candidates = coins
    .filter((c) => c.image && !IMAGE_REFERENCE_EXCLUSIONS.has(c.mint))
    .slice(0, IMAGE_COMPARE_LIMIT);
  const hashes = await Promise.all(candidates.map((c) => remoteImageHash(c.image!)));
  const copy = candidates.find(
    (_, i) => hashes[i] !== null && hashDistance(hash, hashes[i]!) <= IMAGE_DISTANCE
  );
  return copy
    ? { field: 'image', error: `That image is a copy of $${copy.symbol}'s. Upload your own art.` }
    : null;
}

/**
 * Runs every anti-vamp rule. Returns the first rejection, or null if the launch may go ahead.
 * Cheap local rules run before the network ones.
 */
export async function checkLaunch(input: LaunchInput): Promise<Rejection | null> {
  const ticker = normalizeTicker(input.symbol);
  if (ticker.length === 0)
    return { field: 'ticker', error: 'Add a ticker with at least one letter or number.' };

  // The typing pre-check shares the board cache; only a real upload forces a refresh.
  const coins = await listCoins({ fresh: !!input.image });

  const local = tickerRule(ticker, coins) ?? nameRule(input.name, coins);
  if (local) return local;

  if (input.sourceUrl) {
    const postId = parseSourcePost(input.sourceUrl);
    if (!postId) return { field: 'source', error: 'Paste a link to a single post on X.' };
    const used = sourceRule(postId, coins);
    if (used) return used;
  }

  return (await marketRule(ticker)) ?? (input.image ? await imageRule(input.image, coins) : null);
}
