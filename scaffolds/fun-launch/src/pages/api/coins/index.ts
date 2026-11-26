import { apiGuard } from '@/server/apiGuard';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { CoinsResponse } from '@/lib/coin';
import { displayStore, sharedClock, sharedCoins } from '@/server/display';

/** The board, read from the display index. No RPC calls happen per request. */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CoinsResponse | { error: string }>
) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'private, no-store');
  const store = displayStore();
  if (!store)
    return res.status(200).json({ coins: [], serverTime: 0, clockStale: true, stale: true });
  try {
    const [coins, clock] = await Promise.all([sharedCoins(store), sharedClock(store)]);
    return res.status(200).json({
      coins,
      serverTime: clock.serverTime,
      clockStale: clock.clockStale,
      stale: clock.stale,
      updatedAt: Math.floor(Date.now() / 1000),
    });
  } catch {
    res.setHeader('Retry-After', '5');
    return res
      .status(503)
      .json({ error: 'Launches are temporarily unavailable. Please retry shortly.' });
  }
}
