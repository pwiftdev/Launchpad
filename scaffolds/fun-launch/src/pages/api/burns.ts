import type { NextApiRequest, NextApiResponse } from 'next';
import { apiGuard } from '@/server/apiGuard';
import { networkGenesis } from '@/server/dbc';
import { readBurnReceipts } from '@/server/burnReceipts';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    const genesis = await networkGenesis();
    return res.status(200).json(await readBurnReceipts(genesis, undefined, 'bond-v1'));
  } catch {
    return res.status(503).json({ error: 'Verified burn receipts are temporarily unavailable' });
  }
}
