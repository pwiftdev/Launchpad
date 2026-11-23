import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { apiGuard } from '@/server/apiGuard';
import { getCoin } from '@/server/dbc';
import { allowTrading } from '@/server/tradingAccess';
import { buildGraduationTransactions } from '@/server/graduation';

export const config = { api: { bodyParser: { sizeLimit: '2kb' } } };
const input = z
  .object({ mint: z.string().min(32).max(44), wallet: z.string().min(32).max(44) })
  .strict();
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const parsed = input.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid migration request' });
  try {
    const found = await getCoin(parsed.data.mint);
    if (!found) return res.status(404).json({ error: 'Unknown launch' });
    const mode = found.coin.mode;
    if (!(await allowTrading(res, mode === 'creator' || mode === 'community' ? 'bond' : mode))) return;
    const payer = new PublicKey(parsed.data.wallet);
    if (!PublicKey.isOnCurve(payer.toBytes())) throw new Error('A wallet signer is required');
    return res
      .status(200)
      .json(await buildGraduationTransactions(new PublicKey(parsed.data.mint), payer));
  } catch {
    return res.status(422).json({
      error:
        'Could not prepare graduation. The pool must reach its migration threshold; reload before retrying.',
    });
  }
}
