import type { NextApiRequest, NextApiResponse } from 'next';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { apiGuard } from '@/server/apiGuard';
import { connection, parseKey } from '@/server/dbc';
import type { BalanceResponse } from '@/lib/coin';

/** One wallet's SOL and token balance for the trade panel's presets. Read-only. */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<BalanceResponse | { error: string }>
) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const mint = parseKey(req.query.mint);
  const wallet = parseKey(req.query.wallet);
  if (!mint || !wallet) return res.status(400).json({ error: 'Invalid mint or wallet address' });
  try {
    const [lamports, accounts] = await Promise.all([
      connection.getBalance(wallet, 'confirmed'),
      connection.getParsedTokenAccountsByOwner(wallet, { mint }, 'confirmed'),
    ]);
    const tokens = accounts.value.reduce((sum, { account }) => {
      const amount = (
        account.data as { parsed?: { info?: { tokenAmount?: { uiAmount?: unknown } } } }
      ).parsed?.info?.tokenAmount?.uiAmount;
      return sum + (typeof amount === 'number' && Number.isFinite(amount) ? amount : 0);
    }, 0);
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json({ sol: lamports / LAMPORTS_PER_SOL, tokens });
  } catch {
    console.error('Balance request failed');
    res.status(503).json({ error: 'Could not load balance' });
  }
}
