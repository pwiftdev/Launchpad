import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { swapSchema, tradeUnits, uploadSchema } from './validation';

describe('API input boundaries', () => {
  it('admits only the explicit Bond it. mode and refuses selectable burn routing', () => {
    expect(uploadSchema.shape.mode.safeParse('bond').success).toBe(true);
    for (const mode of ['creator', 'community', undefined, null])
      expect(uploadSchema.shape.mode.safeParse(mode).success).toBe(false);
    expect(uploadSchema.shape.burnShare.safeParse(0).success).toBe(true);
    for (const share of [25, 50, 75, 100])
      expect(uploadSchema.shape.burnShare.safeParse(share).success).toBe(false);
  });
  it.each([null, [], {}, 'bad', 5])('rejects malformed swap bodies: %s', (body) => {
    expect(swapSchema.safeParse(body).success).toBe(false);
  });
  it('rejects non-numeric, non-finite and excessive slippage', () => {
    const body = {
      mint: PublicKey.default.toBase58(),
      wallet: PublicKey.default.toBase58(),
      side: 'buy',
      amount: 1,
    };
    expect(swapSchema.safeParse(body).success).toBe(true);
    for (const slippageBps of ['300', null, Infinity, -1, 501, 0.5]) {
      expect(swapSchema.safeParse({ ...body, slippageBps }).success).toBe(false);
    }
  });
  it('rejects dust, overflow and imprecise values before conversion to BN', () => {
    expect(tradeUnits(0.0000000001, 'buy')).toBeNull();
    expect(tradeUnits(1e30, 'buy')).toBeNull();
    expect(tradeUnits(NaN, 'sell')).toBeNull();
    expect(tradeUnits(0.5, 'buy')).toBe(500_000_000);
    expect(tradeUnits(1.5, 'sell')).toBe(1_500_000);
  });
  it('rejects oversized and wrongly typed launch fields', () => {
    expect(uploadSchema.safeParse({ tokenName: {} }).success).toBe(false);
    expect(uploadSchema.shape.tokenName.safeParse('a'.repeat(33)).success).toBe(false);
    expect(uploadSchema.shape.tokenName.safeParse('😀'.repeat(9)).success).toBe(false);
    expect(uploadSchema.shape.tokenLogo.safeParse('x'.repeat(2_800_001)).success).toBe(false);
  });
});
