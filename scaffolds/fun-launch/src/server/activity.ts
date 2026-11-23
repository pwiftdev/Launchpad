// Server-only: a coin plus its decoded trade history and holder-pot totals.
import BN from 'bn.js';
import { getPriceFromSqrtPrice } from '@meteora-ag/dynamic-bonding-curve-sdk';
import type { Coin } from '@/lib/coin';
import { computePot, type PotSummary } from '@/lib/pot';
import { getCoin, getConfig } from './dbc';
import { PublicKey } from '@solana/web3.js';
import { getTradeHistory, type TradeHistory } from './trades';

export type CoinActivity = {
  coin: Coin;
  history: TradeHistory;
  pot: PotSummary;
  launchPriceSol: number;
};

/** Looks the coin up in the cached board list first, then on chain for brand-new coins. */
export async function findCoin(mint: string): Promise<Coin | null> {
  return (await getCoin(mint, { fresh: false }))?.coin ?? null;
}

export async function getCoinActivity(mint: string): Promise<CoinActivity | null> {
  const coin = await findCoin(mint);
  if (!coin) return null;
  const [histories, config] = await Promise.all([
    Promise.all([
      getTradeHistory(coin.pool, coin),
      ...(coin.migratedPool ? [getTradeHistory(coin.migratedPool, coin)] : []),
    ]),
    getConfig(coin.configKey ? new PublicKey(coin.configKey) : undefined),
  ]);
  const history: TradeHistory = {
    trades: histories.flatMap((item) => item.trades).sort((a, b) => b.ts - a.ts),
    complete: histories.every((item) => item.complete),
    stale: histories.some((item) => item.stale),
    updatedAt: Math.min(...histories.map((item) => item.updatedAt ?? 0)),
    pendingCount: histories.reduce((sum, item) => sum + (item.pendingCount ?? 0), 0),
  };
  const launchPriceSol = Number(
    getPriceFromSqrtPrice(
      config.sqrtStartPrice as BN,
      coin.tokenDecimals ?? config.tokenDecimal,
      9
    ).toString()
  );
  return { coin, history, pot: computePot(history.trades, coin.launchedAt), launchPriceSol: launchPriceSol * (coin.quoteToSol ?? 1) };
}
