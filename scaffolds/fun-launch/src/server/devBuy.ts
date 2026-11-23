import BN from 'bn.js';
import { dbc, getConfig } from './dbc';
import { DEV_BUY_MAX_PERCENT_OF_SUPPLY } from '@/constants/launch';
import type { PoolConfig } from '@meteora-ag/dynamic-bonding-curve-sdk';

export type DevBuyQuote = {
  percent: number;
  tokens: number;
  /** SOL the dev pays, fee included (lamports as BN for the transaction) */
  costLamports: BN;
  costSol: number;
  feeSol: number;
};

/**
 * Prices a dev first buy of `percent` of supply on a fresh pool.
 * It runs in the create transaction, so it gets the 1.25% min fee.
 */
export async function quoteDevBuy(
  percent: number,
  verifiedConfig?: PoolConfig
): Promise<DevBuyQuote> {
  if (!Number.isFinite(percent) || !(percent > 0) || percent > DEV_BUY_MAX_PERCENT_OF_SUPPLY) {
    throw new Error(`Dev buy must be between 0 and ${DEV_BUY_MAX_PERCENT_OF_SUPPLY}% of supply`);
  }
  const config = verifiedConfig ?? (await getConfig());
  if (!config.enableFirstSwapWithMinFee)
    throw new Error('Bundled first buy is not enabled for this config');
  const decimals = config.tokenDecimal;
  const supply = Number(config.preMigrationTokenSupply.toString()) / 10 ** decimals;
  const tokens = Math.floor((supply * percent) / 100);
  if (tokens < 1) throw new Error('Dev buy must include at least one token');
  const q = dbc.pool.getQuoteFromOutputAmount({
    config,
    swapBaseForQuote: false,
    amountOut: new BN(tokens).mul(new BN(10 ** decimals)),
    eligibleForFirstSwapWithMinFee: true,
    hasReferral: false,
  });
  const fee = Number(q.tradingFee.add(q.protocolFee).add(q.referralFee).toString());
  const costLamports = new BN(q.includedFeeInputAmount.toString());
  return {
    percent,
    tokens,
    costLamports,
    costSol: Number(costLamports.toString()) / 1e9,
    feeSol: fee / 1e9,
  };
}
