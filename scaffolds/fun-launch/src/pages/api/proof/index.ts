import type { NextApiRequest, NextApiResponse } from 'next';
import { apiGuard } from '@/server/apiGuard';
import { networkGenesis } from '@/server/dbc';
import { proofView } from '@/server/proof';

/** Public proof: what Masked earned, burned and paid each day, and what it holds. */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Proof is unavailable' });
  try {
    const view = await proofView(await networkGenesis());
    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
    return res.status(200).json(view);
  } catch (error) {
    console.error('Proof read failed', error instanceof Error ? error.message : error);
    return res.status(503).json({ error: 'Proof is temporarily unavailable' });
  }
}
