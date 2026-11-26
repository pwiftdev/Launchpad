import { z } from 'zod';
import type { Coin, Trade } from '@/lib/coin';
import { QUOTES } from '@/lib/feeModes';
import { summarizeMarket } from '@/lib/market';
import { readLimited } from './remote';
import { recordRpcUsage } from './rpcUsage';

const DAY_SECONDS = 86_400;
const POOL_RETRY_MS = 5 * 60_000;
const TIMEOUT_MS = 650;
const PROVIDER_FAILURES = new Set([401, 403, 429]);
const tradeSample = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      type: z.enum(['buy', 'sell', 'deposit', 'withdrawal']),
      blockchain: z.string(),
      marketAddress: z.string(),
      date: z.number().positive(),
      baseToken: z.object({ address: z.string() }).nullable(),
      quoteToken: z.object({ address: z.string() }).nullable(),
      baseTokenAmount: z.number().nonnegative(),
      quoteTokenAmount: z.number().nonnegative(),
    })
  ),
});

const poolRetryAt = new Map<string, number>();
let providerRetryAt = 0;

function indexedTrades(
  sample: z.infer<typeof tradeSample>,
  coin: Coin,
  pool: string,
  rate: number,
  supply: number,
  now: number
) {
  const seen = new Set<string>();
  const trades: Pick<Trade, 'ts' | 'side' | 'marketCapSol' | 'sol' | 'feeSol'>[] = [];
  for (const trade of sample.data) {
    if (trade.type !== 'buy' && trade.type !== 'sell') continue;
    if (
      trade.marketAddress !== pool ||
      trade.baseToken?.address !== coin.mint ||
      trade.quoteToken?.address !== coin.quoteMint ||
      !['solana', 'solana:solana'].includes(trade.blockchain.toLowerCase())
    )
      return null;
    if (seen.has(trade.id)) continue;
    seen.add(trade.id);
    const ts = trade.date > 1e12 ? trade.date / 1000 : trade.date;
    const sol = trade.quoteTokenAmount * rate;
    const marketCapSol = (sol / trade.baseTokenAmount) * supply;
    if (ts < now - DAY_SECONDS || ts > now || !Number.isFinite(marketCapSol) || marketCapSol <= 0)
      continue;
    trades.push({ ts, side: trade.type, sol, marketCapSol, feeSol: 0 });
  }
  return trades;
}

export async function mobulaMarketSample(coin: Coin, limit: number, now: number) {
  const key = process.env.MOBULA_API_KEY;
  const pool = coin.migratedPool ?? coin.pool;
  const time = Date.now();
  if (
    !key ||
    process.env.NEXT_PUBLIC_NETWORK !== 'mainnet-beta' ||
    time < providerRetryAt ||
    time < (poolRetryAt.get(pool) ?? 0)
  )
    return null;
  const supply = coin.tokenSupply;
  const rate = coin.quoteMint === QUOTES.sol.mint ? 1 : coin.quoteToSol;
  if (
    !supply ||
    !rate ||
    !Number.isFinite(rate) ||
    rate < 0 ||
    (coin.quoteMint !== QUOTES.sol.mint && coin.quoteMint !== QUOTES.hsol.mint)
  )
    return null;

  const url = new URL('https://api.mobula.io/api/2/token/trades');
  url.search = new URLSearchParams({
    chainId: 'solana:solana',
    address: pool,
    mode: 'pair',
    sortOrder: 'desc',
    limit: String(limit),
    fromDate: new Date((now - DAY_SECONDS) * 1000).toISOString(),
  }).toString();

  let body: unknown;
  try {
    recordRpcUsage('mobula');
    const response = await fetch(url, {
      headers: { Authorization: key },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (PROVIDER_FAILURES.has(response.status)) providerRetryAt = Date.now() + 60_000;
    } else body = JSON.parse((await readLimited(response, 256 * 1024)).toString('utf8'));
  } catch {
    body = null;
  }

  const sample = tradeSample.safeParse(body);
  const trades =
    sample.success && sample.data.data.length <= limit
      ? indexedTrades(sample.data, coin, pool, rate, supply, now)
      : null;
  if (trades?.length) return summarizeMarket(trades, coin.marketCapSol, true, now);
  if (poolRetryAt.size >= 128) poolRetryAt.delete(poolRetryAt.keys().next().value!);
  poolRetryAt.set(pool, time + POOL_RETRY_MS);
  return null;
}
