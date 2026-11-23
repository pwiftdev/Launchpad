import type { Trade } from './coin';
import { TOTAL_SUPPLY } from '@/constants/launch';

export type Candle = { time: number; open: number; high: number; low: number; close: number };

export type TradeBar = Candle & { volumeSol: number; trades: number };

/**
 * Actual recorded post-swap prices only. Empty seconds stay empty, never interpolated.
 * Each bar opens at the previous bar's close, so a bucket with a single swap still shows
 * the move it made instead of a flat tick.
 */
export function buildTradeBars(trades: readonly Trade[], intervalSec: number): TradeBar[] {
  if (!Number.isSafeInteger(intervalSec) || intervalSec < 1) return [];
  const seen = new Set<string>();
  // The API is newest-first; reverse before a stable time sort for same-second swaps.
  const ordered = [...trades]
    .reverse()
    .sort(
      (a, b) =>
        a.ts - b.ts ||
        (a.sig === b.sig
          ? (a.instructionIndex ?? 0) - (b.instructionIndex ?? 0) ||
            (a.eventIndex ?? 0) - (b.eventIndex ?? 0)
          : 0)
    );
  const result: TradeBar[] = [];
  for (const trade of ordered) {
    if (
      !Number.isSafeInteger(trade.ts) ||
      trade.ts < 0 ||
      !Number.isFinite(trade.priceSol) ||
      trade.priceSol <= 0 ||
      !Number.isFinite(trade.sol) ||
      trade.sol < 0
    )
      continue;
    const identity =
      trade.id ?? `${trade.sig}:${trade.instructionIndex ?? 0}:${trade.eventIndex ?? 0}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const time = Math.floor(trade.ts / intervalSec) * intervalSec;
    const previous = result[result.length - 1];
    if (previous?.time === time) {
      previous.high = Math.max(previous.high, trade.priceSol);
      previous.low = Math.min(previous.low, trade.priceSol);
      previous.close = trade.priceSol;
      previous.volumeSol += trade.sol;
      previous.trades += 1;
    } else {
      const open = previous?.close ?? trade.priceSol;
      result.push({
        time,
        open,
        high: Math.max(open, trade.priceSol),
        low: Math.min(open, trade.priceSol),
        close: trade.priceSol,
        volumeSol: trade.sol,
        trades: 1,
      });
    }
  }
  return result;
}

/** No assumed billion-token supply and no silent USD fallback for real charts. */
export function chartValueMultiplier(
  metric: 'price' | 'marketCap',
  currency: 'SOL' | 'USD',
  supply?: number,
  solUsd?: number
): number | null {
  const units = metric === 'price' ? 1 : supply;
  const exchange = currency === 'SOL' ? 1 : solUsd;
  if (
    units === undefined ||
    !Number.isFinite(units) ||
    units < 0 ||
    exchange === undefined ||
    !Number.isFinite(exchange) ||
    exchange <= 0
  )
    return null;
  const multiplier = units * exchange;
  return Number.isFinite(multiplier) ? multiplier : null;
}

/**
 * Builds market-cap candles (in SOL) from trades. Each candle opens at the previous close,
 * and the series starts at the launch price so the first move is visible.
 * All prices use current supply, including old trades: this is a normalized
 * comparison, not a reconstruction of supply at each historical block.
 */
export function buildCandles(
  trades: Trade[],
  launchedAt: number,
  launchPriceSol: number,
  intervalSec: number,
  currentSupply: number = TOTAL_SUPPLY
): Candle[] {
  const bucket = (t: number) => Math.floor(t / intervalSec) * intervalSec;
  const ordered = [...trades].sort(
    (a, b) =>
      a.ts - b.ts ||
      (a.sig === b.sig
        ? (a.instructionIndex ?? 0) - (b.instructionIndex ?? 0) ||
          (a.eventIndex ?? 0) - (b.eventIndex ?? 0)
        : 0)
  );
  const candles: Candle[] = [];
  let last = launchPriceSol * currentSupply;
  candles.push({ time: bucket(launchedAt), open: last, high: last, low: last, close: last });

  for (const t of ordered) {
    const time = bucket(t.ts);
    const value = t.priceSol * currentSupply;
    const current = candles[candles.length - 1];
    if (!current) throw new Error('Missing initial candle');
    if (current.time === time) {
      current.high = Math.max(current.high, value);
      current.low = Math.min(current.low, value);
      current.close = value;
    } else if (time > current.time) {
      candles.push({
        time,
        open: last,
        high: Math.max(last, value),
        low: Math.min(last, value),
        close: value,
      });
    }
    last = value;
  }
  return candles;
}
