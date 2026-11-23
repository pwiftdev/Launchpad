import type { NextApiRequest, NextApiResponse } from 'next';
import { apiGuard } from '@/server/apiGuard';
import { getMarketStats } from '@/server/market';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const data = await getMarketStats();
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json(data);
  } catch {
    return res.status(503).json({ error: 'Market statistics are temporarily unavailable' });
  }
}
