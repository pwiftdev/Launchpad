import { apiGuard } from '@/server/apiGuard';
import type { NextApiRequest, NextApiResponse } from 'next';
import BN from 'bn.js';
import { chainTime, connection, dbc, getCoin, parseKey } from '@/server/dbc';
import type { QuoteResponse } from '@/lib/coin';
import { tradeUnits } from '@/server/validation';
import { migratedSwap } from '@/server/damm';
import { NATIVE_MINT } from '@solana/spl-token';
import { getBaseFeeNumerator } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { minimumTradeOutput } from '@/lib/tradeQuote';

const LAMPORTS = 1e9;

/** GET /api/quote?mint=...&side=buy|sell&amount=... (SOL for buys, tokens for sells) */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<QuoteResponse | { error: string }>
) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const mint = parseKey(req.query.mint);
  const side = req.query.side;
  if (side !== 'buy' && side !== 'sell') return res.status(400).json({ error: 'Invalid side' });
  const amount = Number(req.query.amount);
  if (!mint) return res.status(400).json({ error: 'Invalid mint address' });
  if (!Number.isFinite(amount) || amount <= 0)
    return res.status(400).json({ error: 'Enter an amount' });
  try {
    const found = await getCoin(mint.toBase58());
    if (!found) return res.status(404).json({ error: 'Coin not found on MSKD.fun' });
    const config = found.config,
      decimals = found.coin.tokenDecimals ?? config.tokenDecimal;
    const units = tradeUnits(amount, side, decimals);
    if (units === null) return res.status(400).json({ error: 'Amount is too small or too large' });
    if (found.coin.isMigrated) {
      const quote = await migratedSwap(connection, config, mint, side, new BN(units.toString()), 0);
      const amountOut =
        Number(quote.amountOut.toString()) / (side === 'buy' ? 10 ** decimals : LAMPORTS);
      const tradeSol = side === 'buy' ? amount : amountOut + quote.feeSol;
      return res.status(200).json({
        side,
        amountIn: amount,
        amountOut,
        minimumAmountOut: minimumTradeOutput(quote.amountOut.toString()),
        feeSol: quote.feeSol * (found.coin.quoteToSol ?? 1),
        feePercent: tradeSol > 0 ? (quote.feeSol / tradeSol) * 100 : 0,
        taxPercent: 0,
        route: 'damm-v2',
        pool: quote.pool,
        feeMint: quote.feeMint,
        feeAmount: quote.feeAmount,
        feeSolIsEstimate: quote.feeSolIsEstimate,
      });
    }

    const point =
      config.activationType === 1 ? await chainTime() : await connection.getSlot('confirmed');
    const q = dbc.pool.swapQuote({
      virtualPool: found.account,
      config,
      swapBaseForQuote: side === 'sell',
      amountIn: new BN(units.toString()),
      slippageBps: 0,
      hasReferral: false,
      eligibleForFirstSwapWithMinFee: false,
      currentPoint: new BN(point),
    });

    const fee = Number(q.tradingFee.add(q.protocolFee).add(q.referralFee).toString());
    const out = Number(q.outputAmount.toString());
    const feeInSol = config.collectFeeMode === 0 || side === 'sell';
    const feeAmount = fee / (feeInSol ? LAMPORTS : 10 ** decimals);
    const rate = found.coin.quoteToSol ?? 1;
    const feeSol = feeInSol ? feeAmount * rate : feeAmount * found.coin.priceSol;
    const tradeSol = side === 'buy' ? amount * rate : (out / LAMPORTS) * rate + feeSol;

    const base = config.poolFees.baseFee;
    const tax =
      base.baseFeeMode <= 1
        ? Number(
            getBaseFeeNumerator(
              base.cliffFeeNumerator,
              base.firstFactor,
              base.secondFactor,
              base.thirdFactor,
              base.baseFeeMode,
              new BN(point),
              found.account.poolState.activationPoint
            ).toString()
          ) / 10_000_000
        : 0;
    res.status(200).json({
      side,
      amountIn: amount,
      amountOut: out / (side === 'buy' ? 10 ** decimals : LAMPORTS),
      minimumAmountOut: minimumTradeOutput(q.outputAmount.toString()),
      feeSol,
      feePercent: tradeSol > 0 ? (feeSol / tradeSol) * 100 : 0,
      taxPercent: tax,
      route: 'dbc',
      pool: found.coin.pool,
      feeMint: feeInSol ? (config.quoteMint ?? NATIVE_MINT).toBase58() : mint.toBase58(),
      feeAmount,
      feeSolIsEstimate: !feeInSol,
    });
  } catch {
    console.error('Quote request failed');
    res.status(500).json({ error: 'Quote failed. Please try again.' });
  }
}
