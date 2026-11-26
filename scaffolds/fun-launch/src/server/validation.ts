import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import {
  DEV_BUY_MAX_PERCENT_OF_SUPPLY,
  LAUNCH_IMAGE_MAX_DATA_URL_LENGTH,
  TICKER_CHARACTERS,
  TOKEN_DECIMALS,
} from '@/constants/launch';
import { isSourcePostUrl, normalizeSocial, socialMaxLength, type SocialKind } from '@/lib/socials';

// A submitted link must already be valid for its field; nothing is silently dropped.
const social = (kind: SocialKind) =>
  z
    .string()
    .max(socialMaxLength(kind))
    .refine((value) => normalizeSocial(kind, value) !== null)
    .optional();

const address = z
  .string()
  .min(32)
  .max(44)
  .refine((s) => {
    try {
      new PublicKey(s);
      return true;
    } catch {
      return false;
    }
  });

export const launchMetadataSchema = z.object({
  tokenLogo: z.string().max(LAUNCH_IMAGE_MAX_DATA_URL_LENGTH),
  tokenName: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .refine((s) => Buffer.byteLength(s) <= 32),
  tokenSymbol: z
    .string()
    .trim()
    .min(1)
    .max(10)
    .regex(TICKER_CHARACTERS)
    .refine((s) => Buffer.byteLength(s) <= 10),
  devBuyPercent: z.number().finite().min(0).max(DEV_BUY_MAX_PERCENT_OF_SUPPLY).default(0),
  sourceUrl: z
    .string()
    .max(2048)
    .refine((url) => !url || isSourcePostUrl(url))
    .optional(),
  description: z
    .string()
    .max(500)
    .refine((s) => Buffer.byteLength(s) <= 2000)
    .optional(),
  socials: z
    .object({
      website: social('website'),
      twitter: social('twitter'),
      telegram: social('telegram'),
      discord: social('discord'),
    })
    .strict()
    .optional(),
});

export const uploadSchema = launchMetadataSchema
  .extend({
    mint: address,
    userWallet: address.refine((s) => PublicKey.isOnCurve(new PublicKey(s).toBytes())),
    mode: z.enum(['bond', 'mskd', 'dev', 'cashback', 'hsol', 'cashback-hsol', 'mskd-hsol']),
    configKey: address.optional(),
    // Retained in the signed payload for compatibility; no creator-selectable routing.
    burnShare: z.literal(0).default(0),
    issuedAt: z.number().int(),
    signature: z.string().max(100),
  })
  .refine((data) => (data.mode === 'bond' ? data.configKey === undefined : !!data.configKey), {
    message: 'Signed config key required for this mode',
  });

export const swapSchema = z.object({
  mint: address,
  wallet: address,
  side: z.enum(['buy', 'sell']),
  amount: z.number().finite().positive(),
  quotePool: address.optional(),
  minimumAmountOut: z
    .string()
    .refine((value) => /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n)
    .optional(),
  slippageBps: z.number().int().min(0).max(500).default(300),
});

export function tradeUnits(
  amount: number,
  side: 'buy' | 'sell',
  tokenDecimals = TOKEN_DECIMALS
): number | null {
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 18) return null;
  const value = Math.floor(amount * (side === 'buy' ? 1e9 : 10 ** tokenDecimals));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
