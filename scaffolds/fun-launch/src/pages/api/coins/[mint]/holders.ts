import type { NextApiRequest, NextApiResponse } from 'next';
import { apiGuard } from '@/server/apiGuard';
import { parseKey } from '@/server/dbc';
import { getCoinHolders } from '@/server/holderDisplay';
import type { HoldersResponse } from '@/lib/coin';
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<HoldersResponse | { error: string }>
) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const mint = parseKey(req.query.mint);
  if (!mint) return res.status(400).json({ error: 'Invalid mint address' });
  try {
    const data = await getCoinHolders(mint);
    if (!data) return res.status(404).json({ error: 'Coin not found on MSKD.fun' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json(data);
  } catch {
    console.error('Holders request failed');
    res.status(503).json({ error: 'Could not load holders' });
  }
}
