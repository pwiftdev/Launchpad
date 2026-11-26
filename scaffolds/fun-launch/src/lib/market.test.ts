import { describe, expect, it } from 'vitest';
import type { Trade } from './coin';
import { sparklinePaths, summarizeMarket, totalPoolReserves } from './market';

const now = 2_000_000;
const trade = (overrides: Partial<Trade>): Trade => ({
  sig: 'test',
  ts: now - 60,
  side: 'buy',
  wallet: 'test',
  sol: 1,
  tokens: 10,
  feeSol: 0.1,
  priceSol: 0.0001,
  marketCapSol: 100,
  ...overrides,
});

describe('market summaries', () => {
  it('counts gross SOL once per swap and excludes old and future trades', () => {
    const data = summarizeMarket(
      [
        trade({ side: 'buy', sol: 2 }),
        trade({ side: 'sell', sol: 0.9, feeSol: 0.1 }),
        trade({ ts: now - 86401, sol: 100 }),
        trade({ ts: now + 1, sol: 200 }),
      ],
      120,
      false,
      now
    );
    expect(data.volumeSol).toBeCloseTo(3);
    expect(data.trades).toBe(2);
    expect(data.buys).toBe(1);
    expect(data.sells).toBe(1);
    expect(data.changePercent).toBeCloseTo(20);
  });

  it('keeps chronological observations, caps chart size and preserves the latest price', () => {
    const data = summarizeMarket(
      Array.from({ length: 1000 }, (_, i) => trade({ ts: now - i, marketCapSol: 1100 - i })),
      1200,
      true,
      now
    );
    expect(data.points.length).toBeLessThanOrEqual(41);
    expect(data.points[0]).toBe(101);
    expect(data.points.at(-1)).toBe(1200);
    expect(data.partial).toBe(true);
  });

  it('does not invent a price change when there is no recent history', () => {
    const data = summarizeMarket([], 100, true, now);
    expect(data.points).toEqual([100, 100]);
    expect(data.changePercent).toBeNull();
    expect(data.volumeSol).toBe(0);
  });
});

describe('launchpad pool reserves', () => {
  it('adds current graduated reserves to active curves and counts each pool once', () => {
    expect(
      totalPoolReserves([
        { isMigrated: false, quoteReserveSol: 3.5 },
        { isMigrated: true, quoteReserveSol: 80, migratedQuoteReserveSol: 70.5 },
        { isMigrated: true, quoteReserveSol: 80, migratedQuoteReserveSol: 0 },
      ])
    ).toBe(74);
  });

  it('waits for current graduated reserves when reading an older response', () => {
    expect(totalPoolReserves([{ isMigrated: true, quoteReserveSol: 80 }])).toBeUndefined();
    expect(totalPoolReserves([{ isMigrated: true, isDemo: true, quoteReserveSol: 80 }])).toBe(80);
  });
});

describe('price backdrop geometry', () => {
  it('handles flat series without NaN or infinity', () => {
    const paths = sparklinePaths([100, 100, 100]);
    if (!paths) throw new Error('Expected valid sparkline');
    expect(paths.line).toContain('45.00');
    expect(paths.line).not.toMatch(/NaN|Infinity/);
    expect(paths.area).toMatch(/Z$/);
  });
  it('drops invalid values and rejects histories too short to draw', () => {
    expect(sparklinePaths([NaN, Infinity, -1, 10])).toBeNull();
    expect(sparklinePaths([10, NaN, 20])?.line).not.toContain('NaN');
  });
});
