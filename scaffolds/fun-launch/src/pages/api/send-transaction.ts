import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey, Transaction } from '@solana/web3.js';
import { connection } from '@/server/dbc';
import { apiGuard, clientIp, takeLimit } from '@/server/apiGuard';
import { allowTrading } from '@/server/tradingAccess';
import { validateRelayTransaction } from '@/server/transactionPolicy';

export const config = { api: { bodyParser: { sizeLimit: '8kb' } } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!takeLimit('relay:' + clientIp(req), 20, 60_000)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'Too many transaction requests' });
  }
  const signedTransaction = req.body?.signedTransaction;
  if (
    typeof signedTransaction !== 'string' ||
    signedTransaction.length > 1644 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(signedTransaction)
  ) {
    return res.status(400).json({ error: 'Invalid signed transaction' });
  }
  let raw: Buffer;
  try {
    raw = Buffer.from(signedTransaction, 'base64');
    if (raw.length > 1232) throw new Error('Transaction too large');
    const tx = Transaction.from(raw);
    if (!tx.verifySignatures()) throw new Error('A fully signed transaction is required');
    const claimMint = typeof req.body?.mint === 'string' ? new PublicKey(req.body.mint) : undefined;
    const modes = new Set<import('@/lib/launchModes').LaunchMode>();
    await validateRelayTransaction(tx, { claimMint, onMode: (mode) => modes.add(mode ?? 'bond') });
    if (!modes.size) modes.add('bond');
    for (const mode of modes)
      if (!(await allowTrading(res, mode === 'creator' || mode === 'community' ? 'bond' : mode)))
        return;
  } catch {
    return res.status(400).json({ error: 'A fully signed launch or swap transaction is required' });
  }
  // Confirm in the browser: waiting for chain confirmation can exceed Heroku's request timeout.
  try {
    const signature = await connection.sendRawTransaction(raw, {
      skipPreflight: false,
      maxRetries: 2,
    });
    return res.status(200).json({ success: true, signature });
  } catch {
    console.error('Transaction submission failed');
    return res
      .status(502)
      .json({ error: 'Could not submit transaction. Check your wallet before retrying.' });
  }
}
