import { apiGuard } from '@/server/apiGuard';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSolPrice } from '@/server/solPrice';

/** GET /api/sol-price -> { usd } (mainnet SOL price, used for $ values on every network). */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const price = await getSolPrice();
  if (!price) return res.status(502).json({ error: 'SOL price unavailable' });
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(200).json(price);
}
