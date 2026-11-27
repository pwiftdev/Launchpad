import type { Coin, Trade } from './coin';
import { tradeValueSol } from './pot';

export type TokenMarket = {
  points: number[];
  changePercent: number | null;
  volumeSol: number;
  trades: number;
  buys: number;
  sells: number;
  partial: boolean;
};

export type MarketStats = {
  updatedAt: number;
  network: { slot: number | null; tps: number | null; rpcMs: number | null };
  tokens: Record<string, TokenMarket>;
  volumeSol: number;
  trades: number;
  trackedPools: number;
  totalPools: number;
  partial: boolean;
};

export const POOL_RESERVES_DESCRIPTION =
  'SOL and hSOL quote reserves in active bonding curves and graduated DAMM pools.';

export function totalPoolReserves(
  coins: Pick<Coin, 'isDemo' | 'isMigrated' | 'quoteReserveSol' | 'migratedQuoteReserveSol'>[]
) {
  let total = 0;
  for (const coin of coins) {
    const reserve =
      coin.isMigrated && !coin.isDemo ? coin.migratedQuoteReserveSol : coin.quoteReserveSol;
    if (reserve === undefined || !Number.isFinite(reserve) || reserve < 0) return undefined;
    total += reserve;
  }
  return total;
}

/** Only actual observations enter the series; missing histories do not get invented movement. */
export function summarizeMarket(
  trades: Pick<Trade, 'ts' | 'marketCapSol' | 'sol' | 'feeSol' | 'side'>[],
  currentCap: number,
  partial = false,
  now = Date.now() / 1000
): TokenMarket {
  const recent = trades
    .filter(
      (trade) =>
        trade.ts >= now - 86400 &&
        trade.ts <= now &&
        Number.isFinite(trade.marketCapSol) &&
        trade.marketCapSol > 0
    )
    .sort((a, b) => a.ts - b.ts);
  const values = recent.map((trade) => trade.marketCapSol);
  if (values.length && currentCap > 0) values.push(currentCap);
  const points =
    values.length >= 2
      ? values.filter(
          (_, i) => i === values.length - 1 || i % Math.max(1, Math.ceil(values.length / 40)) === 0
        )
      : [currentCap, currentCap];
  const first = recent[0]?.marketCapSol;
  return {
    points,
    changePercent:
      recent.length >= 2 && first !== undefined && first > 0
        ? (currentCap / first - 1) * 100
        : null,
    volumeSol: recent.reduce((sum, trade) => sum + Math.max(0, tradeValueSol(trade)), 0),
    trades: recent.length,
    buys: recent.filter((trade) => trade.side === 'buy').length,
    sells: recent.filter((trade) => trade.side === 'sell').length,
    partial,
  };
}

/** Convert observations to a small SVG, including stable flat-line and invalid-input handling. */
export function sparklinePaths(
  values: number[],
  width = 240,
  height = 90,
  padding = 6,
  offsets?: number[]
) {
  const points = values
    .map((value, index) => ({ value, offset: offsets?.[index] }))
    .filter(({ value }) => Number.isFinite(value) && value >= 0);
  if (points.length < 2) return null;
  const prices = points.map(({ value }) => value);
  const min = Math.min(...prices);
  const range = Math.max(...prices) - min;
  const positions = points.map(({ value, offset }, i): [number, number] => [
    padding + (offset ?? i / (points.length - 1)) * (width - padding * 2),
    range ? height - padding - ((value - min) / range) * (height - padding * 2) : height / 2,
  ]);
  const line = positions
    .map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`)
    .join(' ');
  return { line, area: `${line} L${width - padding},${height} L${padding},${height} Z` };
}
