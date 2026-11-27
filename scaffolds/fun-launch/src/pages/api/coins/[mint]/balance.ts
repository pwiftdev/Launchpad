import type { NextApiRequest, NextApiResponse } from 'next';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { apiGuard } from '@/server/apiGuard';
import {
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  unpackAccount,
} from '@solana/spl-token';
import { registeredCoin } from '@/server/launchRegistry';
import { connection, parseKey, networkGenesis } from '@/server/dbc';
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
    const registered = await registeredCoin(await networkGenesis(), mint.toBase58());
    let quoteBalance = lamports / LAMPORTS_PER_SOL;
    if (registered?.quote_mint && registered.quote_mint !== NATIVE_MINT.toBase58()) {
      const quoteMint = parseKey(registered.quote_mint);
      if (!quoteMint) throw new Error('Unknown quote mint');
      const ata = getAssociatedTokenAddressSync(quoteMint, wallet);
      const info = await connection.getAccountInfo(ata, 'confirmed');
      const account = info && unpackAccount(ata, info, TOKEN_PROGRAM_ID);
      if (account && (!account.owner.equals(wallet) || !account.mint.equals(quoteMint)))
        throw new Error('Invalid quote balance');
      quoteBalance = account && !account.isFrozen ? Number(account.amount) / 1e9 : 0;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json({ sol: lamports / LAMPORTS_PER_SOL, tokens, quoteBalance });
  } catch {
    console.error('Balance request failed');
    res.status(503).json({ error: 'Could not load balance' });
  }
}
