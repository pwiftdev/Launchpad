import type { NextApiRequest, NextApiResponse } from 'next';
import { apiGuard } from '@/server/apiGuard';
import { parseKey } from '@/server/dbc';
import { displayStore } from '@/server/display';
import type { HoldersResponse } from '@/lib/coin';

/** Every holder from the latest full token-account scan, largest first. */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<HoldersResponse | { error: string }>
) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const mint = parseKey(req.query.mint);
  if (!mint) return res.status(400).json({ error: 'Invalid mint address' });
  const store = displayStore();
  if (!store) return res.status(503).json({ error: 'Holders are unavailable' });
  try {
    const coin = await store.coin(mint.toBase58());
    if (!coin) return res.status(404).json({ error: 'Coin not found on MSKD.fun' });
    const data = await store.holders(coin);
    // The first scan of a new coin follows within seconds; until then the list is empty.
    res.setHeader('Cache-Control', 'private, no-store');
    res
      .status(200)
      .json(data ?? { holders: [], circulating: 0, holderCount: 0, partial: true, stale: true });
  } catch {
    console.error('Holders request failed');
    res.status(503).json({ error: 'Could not load holders' });
  }
}
