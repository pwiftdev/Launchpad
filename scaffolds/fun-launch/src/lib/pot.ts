import type { Trade } from './coin';
import {
  BASE_FEE_PERCENT,
  LEGACY_POT_ESTIMATE_SHARE,
  LAUNCH_TAX_WINDOW_SECONDS,
} from '@/constants/launch';

const DUST_SHARE = 0.0001;

export type PotSummary = {
  /** Legacy devnet estimate, not a funded balance, holder entitlement or buyback budget. */
  potSol: number;
  /** All launch tax paid above the base fee (before the holder share) */
  excessSol: number;
  /** Trades that paid more than the base fee */
  taxedTrades: number;
  /** Total fees paid on every trade, in SOL */
  feesSol: number;
};

/** SOL value of a trade, fee included: buys spend `sol`, sells receive `sol` after the fee. */
export const tradeValueSol = (t: Pick<Trade, 'side' | 'sol' | 'feeSol'>) =>
  t.side === 'buy' ? t.sol : t.sol + t.feeSol;

/**
 * Preserves the historical devnet estimate for old API clients. Never use this estimate for
 * execution or claims; the executed-fee ledger implements the current mainnet policy.
 */
export function computePot(trades: Trade[], launchedAt: number): PotSummary {
  let excessSol = 0;
  let taxedTrades = 0;
  let feesSol = 0;
  for (const t of trades) {
    feesSol += t.feeSol;
    if (t.ts > launchedAt + LAUNCH_TAX_WINDOW_SECONDS) continue;
    const value = tradeValueSol(t);
    const excess = t.feeSol - value * (BASE_FEE_PERCENT / 100);
    // The on-chain floor is 1.2505%, not exactly 1.25%: ignore excess under 0.01% of the trade
    if (excess > value * DUST_SHARE) {
      excessSol += excess;
      taxedTrades += 1;
    }
  }
  return { potSol: excessSol * LEGACY_POT_ESTIMATE_SHARE, excessSol, taxedTrades, feesSol };
}
