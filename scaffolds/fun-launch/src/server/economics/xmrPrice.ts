// SOL and XMR in US dollars, for locking one daily batch rate. The source is configurable;
// a fixed rate is only for stagenet rehearsals.
import { z } from 'zod';

export type XmrQuote = { solUsd: number; xmrUsd: number; source: string; at: Date };
export type XmrPriceSource = () => Promise<XmrQuote>;

const coingecko = z.object({
  solana: z.object({ usd: z.number().positive() }),
  monero: z.object({ usd: z.number().positive() }),
});

export const coingeckoPrice =
  (fetcher: typeof fetch = fetch): XmrPriceSource =>
  async () => {
    const response = await fetcher(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana,monero&vs_currencies=usd',
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!response.ok) throw new Error(`Price source HTTP ${response.status}`);
    const body = coingecko.parse(await response.json());
    return {
      solUsd: body.solana.usd,
      xmrUsd: body.monero.usd,
      source: 'coingecko',
      at: new Date(),
    };
  };

export function priceSourceFromEnv(env = process.env): XmrPriceSource {
  const fixed = env.MASKED_FIXED_SOL_XMR_RATE;
  if (fixed) {
    if (env.NEXT_PUBLIC_NETWORK === 'mainnet-beta')
      throw new Error('A fixed SOL/XMR rate is for test networks only');
    const rate = Number(fixed);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('Invalid MASKED_FIXED_SOL_XMR_RATE');
    return async () => ({ solUsd: rate, xmrUsd: 1, source: 'fixed-test-rate', at: new Date() });
  }
  return coingeckoPrice();
}

export const PICONERO_PER_XMR = 1_000_000_000_000n;
/**
 * Piconero paid per whole SOL of earnings, after the fee. Floors at every step, so rounding
 * always favors the treasury and never pays out more than the locked rate.
 */
export function rateAtomicPerSol(quote: XmrQuote, feeBps: number): bigint {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000) throw new Error('Invalid fee');
  if (!(quote.solUsd > 0) || !(quote.xmrUsd > 0)) throw new Error('Invalid price');
  // Piconero per SOL, from dollar prices kept to six decimal places.
  const sol = BigInt(Math.round(quote.solUsd * 1e6)),
    xmr = BigInt(Math.round(quote.xmrUsd * 1e6));
  const gross = (sol * PICONERO_PER_XMR) / xmr;
  return (gross * BigInt(10_000 - feeBps)) / 10_000n;
}

/** XMR owed for a claim's lamports at the batch rate. */
export const atomicForLamports = (lamports: bigint, rate: bigint) =>
  (lamports * rate) / 1_000_000_000n;
