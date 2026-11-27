import type { NextApiRequest, NextApiResponse } from 'next';
import { apiGuard } from '@/server/apiGuard';
import { BRAND } from '@/constants/brand';
import { displayStore, sharedClock, sharedCoins, sharedRead } from '@/server/display';
import type { MarketStats } from '@/lib/market';

/** 24-hour launchpad figures from indexed trades, plus the network sample the indexer records. */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const store = displayStore();
  if (!store)
    return res.status(503).json({ error: 'Market statistics are temporarily unavailable' });
  try {
    const [coins, clock] = await Promise.all([sharedCoins(store), sharedClock(store)]);
    const ordered = [...coins].sort(
      (a, b) =>
        Number(b.mint === BRAND.officialMint) - Number(a.mint === BRAND.officialMint) ||
        b.launchedAt - a.launchedAt
    );
    const tokens = await sharedRead(`markets:${store.genesis}`, () => store.markets(ordered));
    const tracked = Object.values(tokens);
    const data: MarketStats = {
      updatedAt: Math.floor(Date.now() / 1000),
      network: clock.network,
      tokens,
      volumeSol: tracked.reduce((sum, token) => sum + token.volumeSol, 0),
      trades: tracked.reduce((sum, token) => sum + token.trades, 0),
      trackedPools: tracked.length,
      totalPools: coins.length,
      partial: clock.stale,
    };
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json(data);
  } catch {
    return res.status(503).json({ error: 'Market statistics are temporarily unavailable' });
  }
}
