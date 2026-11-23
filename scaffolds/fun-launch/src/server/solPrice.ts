// Server-only: mainnet SOL/USD price (Jupiter, CoinGecko as fallback), cached 30s.
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TTL_MS = 30_000;
let pending: Promise<void> | null = null;
let cached: { at: number; usd: number } | null = null;

async function fromJupiter(): Promise<number> {
  const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`, {
    signal: AbortSignal.timeout(4000),
  });
  const body = (await res.json()) as Record<string, { usdPrice?: number }>;
  const usd = body[SOL_MINT]?.usdPrice;
  if (!res.ok || typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0)
    throw new Error('No Jupiter price');
  return usd;
}

async function fromCoinGecko(): Promise<number> {
  const res = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
    { signal: AbortSignal.timeout(4000) }
  );
  const usd = ((await res.json()) as { solana?: { usd?: number } }).solana?.usd;
  if (!res.ok || typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0)
    throw new Error('No CoinGecko price');
  return usd;
}

/** Latest SOL price in USD; serves the last known price if both sources fail, null if never fetched. */
export async function getSolPrice(): Promise<{ usd: number; at: number } | null> {
  if (!cached || Date.now() - cached.at > TTL_MS) {
    pending ??= (async () => {
      try {
        cached = { at: Date.now(), usd: await fromJupiter().catch(fromCoinGecko) };
      } catch {
        console.error('SOL price refresh failed');
      }
    })().finally(() => {
      pending = null;
    });
    await pending;
  }
  return cached;
}
