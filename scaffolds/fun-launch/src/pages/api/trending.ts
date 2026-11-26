import { apiGuard } from '@/server/apiGuard';
import type { NextApiRequest, NextApiResponse } from 'next';
import { displayClock, displayStore } from '@/server/display';
import type { TrendingCoin, TrendingResponse } from '@/lib/coin';

/** Runners by market cap, and unbonded coins ranked by swaps in the last hour, from the index. */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<TrendingResponse | { error: string }>
) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'private, no-store');
  const store = displayStore();
  if (!store)
    return res.status(200).json({ runners: [], trending: [], serverTime: 0, clockStale: true });
  try {
    const [coins, counts, clock] = await Promise.all([
      store.coins(),
      store.recentSwapCounts(3600),
      displayClock(store),
    ]);
    const runners = [...coins].sort((a, b) => b.marketCapSol - a.marketCapSol).slice(0, 10);
    const trending: TrendingCoin[] = coins
      .filter((coin) => !coin.isMigrated && (counts.get(coin.mint) ?? 0) > 0)
      .map((coin) => ({ ...coin, txLastHour: counts.get(coin.mint)! }))
      .sort((a, b) => b.txLastHour - a.txLastHour || b.marketCapSol - a.marketCapSol)
      .slice(0, 10);
    return res.status(200).json({
      runners,
      trending,
      serverTime: clock.serverTime,
      clockStale: clock.clockStale,
      stale: clock.stale,
      partial: false,
      updatedAt: Math.floor(Date.now() / 1000),
    });
  } catch {
    res.setHeader('Retry-After', '5');
    return res
      .status(503)
      .json({ error: 'Trending coins are temporarily unavailable. Please retry.' });
  }
}
