import { apiGuard } from '@/server/apiGuard';
import type { NextApiRequest, NextApiResponse } from 'next';
import { displayChainTime, listCoins } from '@/server/dbc';
import { recentTxCount } from '@/server/trades';
import type { Coin, TrendingCoin, TrendingResponse } from '@/lib/coin';

const TTL_MS = 5_000;
const RETRY_MS = 5_000;
const MAX_STALE_MS = 5 * 60_000;
const SCORE_LIMIT = 25;
const SCORE_CONCURRENCY = 4;
const REFRESH_BUDGET_MS = 6_000;
const SAMPLE_LIMIT = 100;
type Score = { count: number; at: number };
type Snapshot = {
  at: number;
  usableUntil: number;
  scores: Map<string, Score>;
  data: Pick<TrendingResponse, 'runners' | 'trending' | 'partial' | 'unavailableScores' | 'stale'>;
};
let pending: Promise<Snapshot> | undefined;
let cached: Snapshot | undefined;
let retryAt = 0;
let clock: { time: number; at: number } | undefined;
let clockRetryAt = 0;

/** Display deadlines never change the financial RPC transport or its commitments. */
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Display refresh timed out')), Math.max(1, ms));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function refresh(): Promise<Snapshot> {
  const began = Date.now();
  const coins = await bounded(listCoins(), REFRESH_BUDGET_MS);
  const runners = [...coins].sort((a, b) => b.marketCapSol - a.marketCapSol).slice(0, 10);
  const unbonded = coins.filter((coin) => !coin.isMigrated);
  const candidates = unbonded.sort((a, b) => b.marketCapSol - a.marketCapSol).slice(0, SCORE_LIMIT);
  const scores = new Map<string, Score>();
  const rows: TrendingCoin[] = [];
  let unavailableScores = 0;
  let usableUntil = Date.now() + MAX_STALE_MS;
  let sampled = false;
  const collect = async (coin: Coin) => {
    try {
      const remaining = REFRESH_BUDGET_MS - (Date.now() - began);
      if (remaining <= 0) throw new Error('Display refresh timed out');
      const count = await bounded(recentTxCount(coin.pool, 3600), remaining);
      if (!Number.isSafeInteger(count) || count < 0 || count > SAMPLE_LIMIT)
        throw new Error('Invalid transaction count');
      scores.set(coin.pool, { count, at: Date.now() });
      sampled ||= count === SAMPLE_LIMIT;
    } catch {
      unavailableScores++;
      // A failed read is unknown, never zero. Reuse only an observation of this exact pool.
      const previous = cached?.scores.get(coin.pool);
      if (previous && Date.now() - previous.at < MAX_STALE_MS) {
        scores.set(coin.pool, previous);
        usableUntil = Math.min(usableUntil, previous.at + MAX_STALE_MS);
      }
    }
  };
  for (let offset = 0; offset < candidates.length; offset += SCORE_CONCURRENCY)
    await Promise.all(candidates.slice(offset, offset + SCORE_CONCURRENCY).map(collect));
  if (candidates.length && !scores.size) throw new Error('Transaction counts are unavailable');
  for (const candidate of candidates) {
    const score = scores.get(candidate.pool);
    if (score && score.count > 0) rows.push({ ...candidate, txLastHour: score.count });
  }
  return {
    at: Date.now(),
    usableUntil,
    scores,
    data: {
      runners,
      trending: rows.sort((a, b) => b.txLastHour - a.txLastHour).slice(0, 10),
      partial: unavailableScores > 0 || unbonded.length > SCORE_LIMIT || sampled,
      unavailableScores,
      stale: unavailableScores > 0,
    },
  };
}

async function snapshot(): Promise<{ result: Snapshot; stale: boolean }> {
  const now = Date.now();
  if (
    cached &&
    now < cached.usableUntil &&
    (now < retryAt || now - cached.at < (cached.data.stale ? RETRY_MS : TTL_MS))
  )
    return { result: cached, stale: now < retryAt || Boolean(cached.data.stale) };
  if (now < retryAt) throw new Error('Trending refresh is backing off');
  pending ??= refresh()
    .then((next) => {
      cached = next;
      retryAt = 0;
      return next;
    })
    .catch((error: unknown) => {
      retryAt = Date.now() + RETRY_MS;
      throw error;
    })
    .finally(() => {
      pending = undefined;
    });
  try {
    return { result: await pending, stale: Boolean(cached?.data.stale) };
  } catch (error) {
    if (cached && Date.now() < cached.usableUntil) return { result: cached, stale: true };
    throw error;
  }
}

async function observedClock(): Promise<{ serverTime: number; clockStale: boolean }> {
  try {
    if (Date.now() < clockRetryAt) throw new Error('Clock refresh is backing off');
    const time = await bounded(displayChainTime(), 1500);
    if (!Number.isSafeInteger(time) || time <= 0) throw new Error('Clock unavailable');
    clock = { time, at: Date.now() };
    clockRetryAt = 0;
    return { serverTime: time, clockStale: false };
  } catch {
    if (Date.now() >= clockRetryAt) clockRetryAt = Date.now() + RETRY_MS;
    if (clock && Date.now() - clock.at < MAX_STALE_MS)
      return { serverTime: clock.time, clockStale: true };
    // Rankings remain useful without a clock. Zero means unknown, never an observed chain timestamp.
    return { serverTime: 0, clockStale: true };
  }
}

/** Display-only rankings. Failed samples stay unknown and cached observations have a finite lifetime. */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<TrendingResponse | { error: string }>
) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    const [{ result, stale }, time] = await Promise.all([snapshot(), observedClock()]);
    return res.status(200).json({
      ...result.data,
      ...time,
      stale,
      updatedAt: Math.floor(result.at / 1000),
      transactionSampleLimit: SAMPLE_LIMIT,
    });
  } catch {
    res.setHeader('Retry-After', '5');
    return res
      .status(503)
      .json({ error: 'Trending coins are temporarily unavailable. Please retry.' });
  }
}
