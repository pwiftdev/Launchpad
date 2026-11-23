import { describe, expect, it, vi, afterEach } from 'vitest';
import { nowSeconds, syncServerClock } from './useNow';
import { taxStateAt } from '@/lib/launchTax';

afterEach(() => vi.restoreAllMocks());
describe('chain-aligned launch countdowns', () => {
  it('does not end snipe tax early when Solana is behind the browser clock', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_050_000);
    const monotonic = vi.spyOn(performance, 'now').mockReturnValue(100);
    syncServerClock(1_010);
    expect(nowSeconds()).toBe(1_010);
    expect(taxStateAt(nowSeconds() - 1_000).isClean).toBe(false);
    expect(nowSeconds(true)).toBe(1_050);
    monotonic.mockReturnValue(17_100);
    expect(taxStateAt(nowSeconds() - 1_000).isClean).toBe(true);
  });
  it('ignores invalid clock samples and browser wall-clock jumps between samples', () => {
    const monotonic = vi.spyOn(performance, 'now').mockReturnValue(0);
    syncServerClock(2_000);
    syncServerClock(Number.NaN);
    syncServerClock(-1);
    vi.spyOn(Date, 'now').mockReturnValue(10_000_000);
    monotonic.mockReturnValue(3_000);
    expect(nowSeconds()).toBe(2_003);
  });
});
