import { apiGuard } from '@/server/apiGuard';
import type { NextApiRequest, NextApiResponse } from 'next';
import { parseKey } from '@/server/dbc';
import { getCoinActivity } from '@/server/activity';
import type { TradesResponse } from '@/lib/coin';

// The panel shows the latest trades; totals still cover the full history
const RETURNED_TRADES = 500;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<TradesResponse | { error: string }>
) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const mint = parseKey(req.query.mint);
  if (!mint) return res.status(400).json({ error: 'Invalid mint address' });
  try {
    const activity = await getCoinActivity(mint.toBase58());
    if (!activity) return res.status(404).json({ error: 'Coin not found on MSKD.fun' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json({
      trades: activity.history.trades.slice(0, RETURNED_TRADES),
      launchPriceSol: activity.launchPriceSol,
      pot: activity.pot,
      complete: activity.history.complete && activity.history.trades.length <= RETURNED_TRADES,
      stale: activity.history.stale,
      updatedAt: activity.history.updatedAt,
      pendingCount: activity.history.pendingCount,
    });
  } catch {
    console.error('Trades request failed');
    res.status(500).json({ error: 'Could not load trades' });
  }
}
