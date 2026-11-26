import type { NextApiRequest, NextApiResponse } from 'next';
import { apiGuard, takeLimit, clientIp } from '@/server/apiGuard';
import { parseKey } from '@/server/dbc';
import { displayStore, sharedCoin, sharedRecentTrades } from '@/server/display';
import { streamLive } from '@/server/liveStream';

export const config = { api: { responseLimit: false } };

/**
 * Live updates for one coin. The changed coin and its newest trades travel in the event, so
 * every viewer updates without a request; only a new holder scan asks the page to refetch.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const key = parseKey(req.query.mint);
  if (!key) return res.status(400).json({ error: 'Invalid mint' });
  if (!takeLimit(`coin-live:${clientIp(req)}`, 20, 60000))
    return res.status(429).json({ error: 'Live feed reconnect limit reached' });
  const store = displayStore();
  if (!store) return res.status(503).json({ error: 'Live updates unavailable' });
  const mint = key.toBase58();
  if (!(await store.coin(mint).catch((): null => null)))
    return res.status(404).json({ error: 'Coin not found' });
  await streamLive(req, res, mint, async (event) => {
    if (event.kind === 'board' || event.kind === 'holders') return { kind: event.kind };
    const coin = await sharedCoin(store, mint);
    if (!coin) return null;
    if (event.kind === 'coin') return { kind: 'coin', coin };
    const { trades } = await sharedRecentTrades(store, coin);
    return { kind: 'trades', coin, trades };
  });
}
