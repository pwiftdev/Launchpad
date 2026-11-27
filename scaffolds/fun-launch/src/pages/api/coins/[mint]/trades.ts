import { apiGuard } from '@/server/apiGuard';
import type { NextApiRequest, NextApiResponse } from 'next';
import { parseKey } from '@/server/dbc';
import { displayStore, sharedClock, sharedRead } from '@/server/display';
import {
  RECENT_TRADE_LIMIT,
  type CoinPriceHistory,
  type RecentTradesResponse,
  type TradesResponse,
} from '@/lib/coin';

// The panel and chart show the latest trades; fee totals cover the full indexed history.
const RETURNED_TRADES = 2000;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<TradesResponse | RecentTradesResponse | CoinPriceHistory | { error: string }>
) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const mint = parseKey(req.query.mint);
  if (!mint) return res.status(400).json({ error: 'Invalid mint address' });
  const store = displayStore();
  if (!store) return res.status(503).json({ error: 'Trade history is unavailable' });
  try {
    const coin = await store.coin(mint.toBase58());
    if (!coin) return res.status(404).json({ error: 'Coin not found on MSKD.fun' });
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.query.view === 'chart') {
      const [prices, clock] = await Promise.all([
        sharedRead(`prices:${store.genesis}:${coin.mint}`, () => store.prices(coin), 15_000),
        sharedClock(store),
      ]);
      return res.status(200).json({ ...prices, stale: clock.stale });
    }
    if (req.query.view === 'recent') {
      const recent = await sharedRead(
        `recent-trades:${store.genesis}:${coin.mint}`,
        () => store.trades(coin, RECENT_TRADE_LIMIT),
        15_000
      );
      return res.status(200).json(recent);
    }
    const [history, pot, status] = await Promise.all([
      store.trades(coin, RETURNED_TRADES),
      store.pot(coin),
      store.status(),
    ]);
    res.status(200).json({
      trades: history.trades,
      launchPriceSol: coin.launchPriceSol ?? history.trades.at(-1)?.priceSol ?? coin.priceSol,
      quoteToSol: coin.quoteToSol,
      pot,
      complete: history.complete,
      stale: status.stale,
      updatedAt: Math.floor(Date.now() / 1000),
    });
  } catch {
    console.error('Trades request failed');
    res.status(500).json({ error: 'Could not load trades' });
  }
}
