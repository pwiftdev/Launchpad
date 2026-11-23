import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { buildCandles } from './candles';
import { getDemoCoins, getDemoHolders, getDemoTrades } from './demo';
import { swapSchema } from '@/server/validation';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('design preview', () => {
  it('contains 25 unique, marked samples across all board stages', () => {
    const coins = getDemoCoins();
    expect(coins).toHaveLength(25);
    expect(new Set(coins.map((coin) => coin.mint)).size).toBe(25);
    expect(new Set(coins.map((coin) => coin.image)).size).toBe(25);
    expect(coins.every((coin) => coin.isDemo && coin.description)).toBe(true);
    expect(coins.filter((coin) => coin.progress < 0.25)).toHaveLength(10);
    expect(coins.filter((coin) => !coin.isMigrated && coin.progress >= 0.25)).toHaveLength(9);
    expect(coins.filter((coin) => coin.isMigrated)).toHaveLength(6);
  });

  it('cannot pass transaction input validation as a real mint', () => {
    for (const coin of getDemoCoins()) {
      expect(
        swapSchema.safeParse({
          mint: coin.mint,
          wallet: PublicKey.default.toBase58(),
          side: 'buy',
          amount: 1,
        }).success
      ).toBe(false);
    }
  });

  it('generates consistent, finite chart and holder data for every sample', () => {
    for (const coin of getDemoCoins()) {
      const history = getDemoTrades(coin);
      expect(history.trades).toHaveLength(96);
      expect(history.trades[0]?.marketCapSol).toBeCloseTo(coin.marketCapSol, 6);
      expect(
        history.trades.every(
          (trade) => trade.ts >= coin.launchedAt && trade.sol > 0 && Number.isFinite(trade.tokens)
        )
      ).toBe(true);
      const candles = buildCandles(history.trades, coin.launchedAt, history.launchPriceSol, 60);
      expect(
        candles.every((candle, i) => i === 0 || candle.time > (candles[i - 1]?.time ?? Infinity))
      ).toBe(true);
      expect(
        getDemoHolders(coin).holders.every(
          (holder) => holder.amount > 0 && holder.shareOfCirculating > 0
        )
      ).toBe(true);
    }
  });

  it('requires the preview flag and devnet, even for direct sample links', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_LAUNCHES', 'true');
    vi.stubEnv('NEXT_PUBLIC_NETWORK', 'mainnet-beta');
    vi.resetModules();
    expect((await import('./demo')).getDemoCoin('demo-bubble-cat')).toBeUndefined();
    vi.stubEnv('NEXT_PUBLIC_NETWORK', 'devnet');
    vi.resetModules();
    expect((await import('./demo')).getDemoCoin('demo-bubble-cat')?.isDemo).toBe(true);
    vi.stubEnv('NEXT_PUBLIC_DEMO_LAUNCHES', 'false');
    vi.resetModules();
    expect((await import('./demo')).getDemoCoin('demo-bubble-cat')).toBeUndefined();
  });
});
