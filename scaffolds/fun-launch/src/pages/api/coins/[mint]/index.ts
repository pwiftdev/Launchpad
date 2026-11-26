import { apiGuard } from '@/server/apiGuard';
import type { NextApiRequest, NextApiResponse } from 'next';
import { parseKey } from '@/server/dbc';
import { displayClock, displayCoin, displayStore } from '@/server/display';
import type { CoinResponse } from '@/lib/coin';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CoinResponse | { error: string }>
) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const mint = parseKey(req.query.mint);
  if (!mint) return res.status(400).json({ error: 'Invalid mint address' });
  try {
    const store = displayStore();
    const [coin, clock] = await Promise.all([
      displayCoin(mint.toBase58()),
      store ? displayClock(store) : { serverTime: 0 },
    ]);
    if (!coin) return res.status(404).json({ error: 'Coin not found on MSKD.fun' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json({ serverTime: clock.serverTime, coin });
  } catch {
    console.error('Get coin request failed');
    res.status(500).json({ error: 'Could not load coin' });
  }
}
