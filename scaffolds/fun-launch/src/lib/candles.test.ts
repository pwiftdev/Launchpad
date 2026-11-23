import { describe, expect, it } from 'vitest';
import { buildCandles, buildTradeBars, chartValueMultiplier } from './candles';
import type { Trade } from './coin';

describe('current-supply market cap candles', () => {
  const trades: Trade[] = [
    {
      sig: 'swap',
      ts: 120,
      side: 'buy',
      wallet: 'wallet',
      sol: 2,
      tokens: 1,
      feeSol: 0,
      priceSol: 0.000002,
      marketCapSol: 2000,
    },
  ];
  it('normalizes launch and cached trade values after a burn', () => {
    const before = buildCandles(trades, 60, 0.000001, 60, 1_000_000_000);
    const after = buildCandles(trades, 60, 0.000001, 60, 800_000_000);
    expect(before.map((c) => c.close)).toEqual([1000, 2000]);
    expect(after).toEqual([
      { time: 60, open: 800, high: 800, low: 800, close: 800 },
      { time: 120, open: 800, high: 1600, low: 800, close: 1600 },
    ]);
    expect(trades[0]?.marketCapSol).toBe(2000);
  });
  it('retains the fixture default and handles a fully burned supply', () => {
    expect(buildCandles(trades, 60, 0.000001, 60)[1]?.close).toBe(2000);
    expect(buildCandles(trades, 60, 0.000001, 60, 0).every((c) => c.close === 0)).toBe(true);
  });
  it('uses execution order for the close when history contains several swaps in one transaction', () => {
    const first = { ...trades[0]!, instructionIndex: 0, eventIndex: 1, priceSol: 0.000002 };
    const last = { ...trades[0]!, instructionIndex: 0, eventIndex: 4, priceSol: 0.000003 };
    const result = buildCandles([last, first], 60, 0.000001, 60, 1_000_000_000);
    expect(result[1]).toEqual({ time: 120, open: 1000, high: 3000, low: 1000, close: 3000 });
  });
});

describe('recorded chart bars', () => {
  const trade = (ts: number, priceSol: number, sol = 1, eventIndex = 0): Trade => ({
    sig: `tx-${ts}`,
    ts,
    priceSol,
    sol,
    eventIndex,
    side: 'buy',
    wallet: 'holder',
    tokens: 1,
    feeSol: 0,
    marketCapSol: 123,
  });
  it('draws nothing without trades, without inventing a launch candle or filling quiet seconds', () => {
    expect(buildTradeBars([], 1)).toEqual([]);
    expect(buildTradeBars([trade(130, 4), trade(100, 2)], 1).map((bar) => bar.time)).toEqual([
      100, 130,
    ]);
  });
  it('builds actual 1s, 5s, 15s and minute OHLC and wallet cash-flow volume', () => {
    const trades = [trade(119, 8, 4), trade(104, 3, 3), trade(102, 5, 2), trade(100, 2, 1)];
    expect(buildTradeBars(trades, 1)).toHaveLength(4);
    expect(buildTradeBars(trades, 5)).toEqual([
      { time: 100, open: 2, high: 5, low: 2, close: 3, volumeSol: 6, trades: 3 },
      { time: 115, open: 3, high: 8, low: 3, close: 8, volumeSol: 4, trades: 1 },
    ]);
    expect(buildTradeBars(trades, 15).map((bar) => bar.time)).toEqual([90, 105]);
    expect(buildTradeBars(trades, 60)).toEqual([
      { time: 60, open: 2, high: 8, low: 2, close: 8, volumeSol: 10, trades: 4 },
    ]);
    // Market cap values supplied in cached trades are never chart price authority.
    expect(trades.every((row) => row.marketCapSol === 123)).toBe(true);
  });
  it('keeps distinct swaps in the same transaction, deduplicates exact identities and closes in execution order', () => {
    const early = { ...trade(100, 2), sig: 'same', instructionIndex: 2, eventIndex: 1 };
    const late = { ...trade(100, 5), sig: 'same', instructionIndex: 2, eventIndex: 4 };
    expect(buildTradeBars([late, early, early], 1)).toEqual([
      { time: 100, open: 2, high: 5, low: 2, close: 5, volumeSol: 2, trades: 2 },
    ]);
    expect(buildTradeBars([trade(100, 5), { ...trade(100, 2), sig: 'other' }], 1)[0]?.open).toBe(2);
  });
  it('rejects invalid buckets and nonfinite/negative inputs without poisoning the canvas', () => {
    expect(buildTradeBars([trade(1, 2)], 0)).toEqual([]);
    expect(buildTradeBars([trade(1, 2)], 1.5)).toEqual([]);
    expect(
      buildTradeBars(
        [
          trade(2, NaN),
          trade(3, Infinity),
          trade(4, -1),
          trade(5, 1, -1),
          trade(6, 1, Infinity),
          trade(7.2, 2),
          trade(8, 2),
        ],
        1
      )
    ).toHaveLength(1);
  });
  it('requires verified supply for market cap and a positive USD quote without silent unit changes', () => {
    expect(chartValueMultiplier('price', 'SOL')).toBe(1);
    expect(chartValueMultiplier('marketCap', 'SOL')).toBeNull();
    expect(chartValueMultiplier('marketCap', 'SOL', 800_000_000)).toBe(800_000_000);
    expect(chartValueMultiplier('price', 'USD', undefined, 150)).toBe(150);
    expect(chartValueMultiplier('marketCap', 'USD', 800_000_000, 150)).toBe(120_000_000_000);
    expect(chartValueMultiplier('marketCap', 'SOL', 0)).toBe(0);
    expect(chartValueMultiplier('marketCap', 'SOL', NaN)).toBeNull();
    expect(chartValueMultiplier('price', 'USD', undefined, 0)).toBeNull();
    expect(chartValueMultiplier('price', 'USD')).toBeNull();
  });
});
