import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { LAUNCH_IMAGE_MAX_DATA_URL_LENGTH } from '@/constants/launch';
import { swapSchema, tradeUnits, uploadSchema } from './validation';

describe('API input boundaries', () => {
  it('admits only Masked launches with a 10% creator share step and refuses burn routing', () => {
    expect(uploadSchema.shape.mode.safeParse('masked').success).toBe(true);
    for (const mode of ['bond', 'dev', 'cashback', 'mskd', 'hsol', 'creator', undefined, null])
      expect(uploadSchema.shape.mode.safeParse(mode).success).toBe(false);
    for (const share of [0, 3000, 10_000])
      expect(uploadSchema.shape.creatorShareBps.safeParse(share).success).toBe(true);
    for (const share of [-1000, 2500, 10_001, '1000', undefined])
      expect(uploadSchema.shape.creatorShareBps.safeParse(share).success).toBe(false);
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
    const tokenLogo = uploadSchema.shape.tokenLogo;
    expect(tokenLogo.safeParse('x'.repeat(LAUNCH_IMAGE_MAX_DATA_URL_LENGTH)).success).toBe(true);
    expect(tokenLogo.safeParse('x'.repeat(LAUNCH_IMAGE_MAX_DATA_URL_LENGTH + 1)).success).toBe(
      false
    );
  });
  it('validates ticker characters and optional source post links', () => {
    expect(uploadSchema.shape.tokenSymbol.safeParse('ＭＳＫＤ').success).toBe(false);
    expect(uploadSchema.shape.tokenSymbol.safeParse('猫').success).toBe(true);
    expect(uploadSchema.shape.tokenSymbol.safeParse('$---').success).toBe(false);
    const source = uploadSchema.shape.sourceUrl;
    expect(source.safeParse('https://mobile.twitter.com/mskd/status/12345?s=20').success).toBe(
      true
    );
    expect(source.safeParse(undefined).success).toBe(true);
    expect(source.safeParse('https://x.com/mskd').success).toBe(false);
    expect(source.safeParse('https://x.com.example/mskd/status/12345').success).toBe(false);
  });
  it('accepts post and other X links in token metadata', () => {
    const socials = uploadSchema.shape.socials;
    expect(socials.safeParse({ twitter: 'https://x.com/mskdfun/status/12345?s=20' }).success).toBe(
      true
    );
    expect(
      socials.safeParse({ twitter: `https://x.com/search?q=${'a'.repeat(300)}` }).success
    ).toBe(true);
    expect(socials.safeParse({ twitter: 'https://x.com.example/mskd/status/12345' }).success).toBe(
      false
    );
  });
});
