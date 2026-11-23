import { apiGuard } from '@/server/apiGuard';
import type { NextApiRequest, NextApiResponse } from 'next';
import { displayChainTime, listCoins } from '@/server/dbc';
import type { Coin, CoinsResponse } from '@/lib/coin';

const MAX_STALE_MS = 120_000;
const RETRY_MS = 5000;
let previous: { at: number; coins: Coin[] } | undefined;
let pending: Promise<{ at: number; coins: Coin[] }> | undefined;
let retryAt = 0;
let clock: { at: number; time: number } | undefined;
let clockRetryAt = 0;

async function bounded<T>(work: Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Display request timed out')), timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** This fallback is confined to the public display route. Fresh financial and launch reads never use it. */
async function displayCoins() {
  if (Date.now() < retryAt) {
    if (previous && Date.now() - previous.at < MAX_STALE_MS) return { ...previous, stale: true };
    throw new Error('Coin display refresh is backing off');
  }
  pending ??= bounded(listCoins(), 6000)
    .then((coins) => {
      previous = { coins, at: Date.now() };
      retryAt = 0;
      return previous;
    })
    .catch((error: unknown) => {
      retryAt = Date.now() + RETRY_MS;
      throw error;
    })
    .finally(() => {
      pending = undefined;
    });
  try {
    return { ...(await pending), stale: false };
  } catch (error) {
    if (previous && Date.now() - previous.at < MAX_STALE_MS) return { ...previous, stale: true };
    throw error;
  }
}

async function observedClock() {
  try {
    if (Date.now() < clockRetryAt) throw new Error('Display clock is backing off');
    const time = await bounded(displayChainTime(), 1500);
    if (!Number.isSafeInteger(time) || time <= 0) throw new Error('Invalid display clock');
    clock = { at: Date.now(), time };
    clockRetryAt = 0;
    return { serverTime: time, clockStale: false };
  } catch {
    if (Date.now() >= clockRetryAt) clockRetryAt = Date.now() + RETRY_MS;
    // Never advance a cached timestamp with the host clock or synchronize timers from an unknown zero.
    return {
      serverTime: clock && Date.now() - clock.at < MAX_STALE_MS ? clock.time : 0,
      clockStale: true,
    };
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CoinsResponse | { error: string }>
) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    const [snapshot, time] = await Promise.all([displayCoins(), observedClock()]);
    return res.status(200).json({
      coins: snapshot.coins,
      ...time,
      stale: snapshot.stale,
      updatedAt: Math.floor(snapshot.at / 1000),
    });
  } catch {
    res.setHeader('Retry-After', '5');
    return res
      .status(503)
      .json({ error: 'Launches are temporarily unavailable. Please retry shortly.' });
  }
}
