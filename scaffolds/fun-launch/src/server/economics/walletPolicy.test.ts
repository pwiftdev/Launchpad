import { expect, it } from 'vitest';
import { treasuryIntent, MINIMUM_BUYBACK_LAMPORTS } from './walletPolicy';
it('keeps a durable treasury intent for the whole quarter hour and advances at the boundary', () => {
  expect(treasuryIntent(1800)).toBe(treasuryIntent(2699));
  expect(treasuryIntent(2700)).not.toBe(treasuryIntent(2699));
  expect(() => treasuryIntent(-1)).toThrow();
  expect(MINIMUM_BUYBACK_LAMPORTS).toBe(25_000_000n);
});
