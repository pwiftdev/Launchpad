import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { apiGuard } from '@/server/apiGuard';
import { networkGenesis } from '@/server/dbc';
import { recordMigrationTransaction } from '@/server/migrationRegistry';
const input = z
  .object({
    mint: z.string().min(32).max(44),
    signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/),
  })
  .strict();
export const config = { api: { bodyParser: { sizeLimit: '2kb' } } };
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const parsed = input.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid migration confirmation' });
  try {
    const proof = await recordMigrationTransaction(
      await networkGenesis(true),
      new PublicKey(parsed.data.mint).toBase58(),
      parsed.data.signature
    );
    return proof
      ? res.status(200).json({ status: 'registered', signature: proof.signature, slot: proof.slot })
      : res.status(202).json({ status: 'pending', retryAfterMs: 2000 });
  } catch {
    return res.status(422).json({
      error:
        'Could not verify the finalized migration. Reload and retry confirmation without migrating again.',
    });
  }
}
