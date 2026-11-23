import { apiGuard } from '@/server/apiGuard';
import type { NextApiRequest, NextApiResponse } from 'next';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { chainTime, connection, dbc, getCoin, parseKey, networkGenesis } from '@/server/dbc';
import { swapSchema, tradeUnits } from '@/server/validation';
import { allowTrading } from '@/server/tradingAccess';
import { migratedSwap } from '@/server/damm';

/** Builds an unsigned DBC swap transaction for the user's wallet to sign. */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const parsed = swapSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: 'Invalid swap fields or slippage (maximum 5%)' });
  const { mint: mintStr, side, amount, wallet: walletStr, slippageBps = 300 } = parsed.data;
  const mint = parseKey(mintStr);
  const wallet = parseKey(walletStr);
  if (!mint || !wallet) return res.status(400).json({ error: 'Invalid mint or wallet' });
  if (side !== 'buy' && side !== 'sell') return res.status(400).json({ error: 'Invalid side' });
  if (!Number.isFinite(amount) || amount <= 0)
    return res.status(400).json({ error: 'Enter an amount' });
  try {
    const found = await getCoin(mint.toBase58());
    if (!found) return res.status(404).json({ error: 'Coin not found on MSKD.fun' });
    const mode = found.coin.mode;
    if (!(await allowTrading(res, mode === 'creator' || mode === 'community' ? 'bond' : mode))) return;
    const config = found.config,
      units = tradeUnits(amount, side, found.coin.tokenDecimals ?? config.tokenDecimal);
    if (units === null) return res.status(400).json({ error: 'Amount is too small or too large' });
    const amountIn = new BN(units.toString());
    if (found.coin.isMigrated) {
      const quote = await migratedSwap(
        connection,
        config,
        mint,
        side,
        amountIn,
        slippageBps,
        wallet
      );
      const tx = quote.transaction;
      if (!tx) throw new Error('Migrated transaction unavailable');
      const [block, genesis] = await Promise.all([
        connection.getLatestBlockhashAndContext('confirmed'),
        networkGenesis(),
      ]);
      const { blockhash, lastValidBlockHeight } = block.value,
        preparedSlot = block.context.slot;
      tx.feePayer = wallet;
      tx.recentBlockhash = blockhash;
      return res.status(200).json({
        tx: tx
          .serialize({ requireAllSignatures: false, verifySignatures: false })
          .toString('base64'),
        route: 'damm-v2',
        lastValidBlockHeight,
        preparedSlot,
        genesis,
      });
    }
    const quote = dbc.pool.swapQuote({
      virtualPool: found.account,
      config,
      swapBaseForQuote: side === 'sell',
      amountIn,
      slippageBps,
      hasReferral: false,
      eligibleForFirstSwapWithMinFee: false,
      currentPoint: new BN(
        config.activationType === 1 ? await chainTime() : await connection.getSlot('confirmed')
      ),
    });

    const tx = await dbc.pool.swap({
      owner: wallet,
      pool: new PublicKey(found.coin.pool),
      amountIn,
      minimumAmountOut: quote.minimumAmountOut,
      swapBaseForQuote: side === 'sell',
      referralTokenAccount: null,
    });
    const [block, genesis] = await Promise.all([
      connection.getLatestBlockhashAndContext('confirmed'),
      networkGenesis(),
    ]);
    const { blockhash, lastValidBlockHeight } = block.value,
      preparedSlot = block.context.slot;
    tx.feePayer = wallet;
    tx.recentBlockhash = blockhash;

    res.status(200).json({
      lastValidBlockHeight,
      preparedSlot,
      genesis,
      tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    });
  } catch {
    console.error('Swap transaction preparation failed');
    res.status(500).json({ error: 'Could not build swap. Please try again.' });
  }
}
