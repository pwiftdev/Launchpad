import { apiGuard } from '@/server/apiGuard';
import type { NextApiRequest, NextApiResponse } from 'next';
import { quoteDevBuy } from '@/server/devBuy';

/** GET /api/dev-buy-quote?percent=1.5 -> SOL cost of a dev first buy of that share of supply */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const q = await quoteDevBuy(Number(req.query.percent));
    res.setHeader('Cache-Control', 'private, no-store');
    res
      .status(200)
      .json({ percent: q.percent, tokens: q.tokens, costSol: q.costSol, feeSol: q.feeSol });
  } catch {
    res
      .status(400)
      .json({ error: 'Could not quote that dev buy. Check the percentage and try again.' });
  }
}
