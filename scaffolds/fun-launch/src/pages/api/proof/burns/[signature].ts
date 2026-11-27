import type { NextApiRequest, NextApiResponse } from 'next';
import { apiGuard } from '@/server/apiGuard';
import { networkGenesis } from '@/server/dbc';
import { burnReceipt } from '@/server/proof';
import { transactionSignature } from '@/lib/accessRoutes';

/** The public receipt for one $MSKD buyback and burn. */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const signature = String(req.query.signature ?? '');
  if (!transactionSignature(signature)) return res.status(400).json({ error: 'Invalid signature' });
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Proof is unavailable' });
  try {
    const receipt = await burnReceipt(await networkGenesis(), signature);
    if (!receipt) return res.status(404).json({ error: 'No $MSKD burn has this signature' });
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(200).json(receipt);
  } catch (error) {
    console.error('Burn receipt read failed', error instanceof Error ? error.message : error);
    return res.status(503).json({ error: 'Proof is temporarily unavailable' });
  }
}
