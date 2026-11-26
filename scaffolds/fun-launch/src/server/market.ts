import { PublicKey, type PerfSample } from '@solana/web3.js';
import { BRAND } from '@/constants/brand';
import { connection, listCoins } from './dbc';
import { decodeTrades } from './trades';
import { displayTrade } from './tradeDecoder';
import { mobulaMarketSample } from './mobulaMarket';
import { summarizeMarket, type MarketStats, type TokenMarket } from '@/lib/market';
import type { Coin, Trade } from '@/lib/coin';

const TTL_MS = 60_000;
const QUIET_POOL_TTL_SECONDS = 300;
const POOL_CONCURRENCY = 4;
const TX_LIMIT = 24;
type PoolSample = {
  decoded: Map<string, Trade[]>;
  quiet?: { until: number; reserve: number; price: number };
};
const samplesByPool = new Map<string, PoolSample>();
let cached: MarketStats | null = null;
let pending: Promise<MarketStats> | null = null;

function poolSampleKey(coin: Coin) {
  return `${coin.migratedPool ?? coin.pool}:${coin.tokenDecimals}:${coin.migratedBaseIsA}:${coin.dbcCollectFeeMode}`;
}

async function tokenStats(coin: Coin, now: number, key: string): Promise<TokenMarket> {
  const pool = coin.migratedPool ?? coin.pool;
  const since = Math.floor(now) - 86400;
  const signatures = await connection.getSignaturesForAddress(
    new PublicKey(pool),
    { limit: TX_LIMIT },
    'confirmed'
  );
  const recent = signatures.filter((sig) => !sig.err && (sig.blockTime ?? 0) >= since);
  const previous = samplesByPool.get(key)?.decoded;
  const missing = recent.filter(({ signature }) => !previous?.has(signature));
  const txs = missing.length
    ? await connection.getTransactions(
        missing.map((sig) => sig.signature),
        { commitment: 'confirmed', maxSupportedTransactionVersion: 1 }
      )
    : [];
  const sample = new Map<string, Trade[]>();
  for (const { signature } of recent) {
    const decoded = previous?.get(signature);
    if (decoded) sample.set(signature, decoded);
  }
  for (const [index, { signature }] of missing.entries()) {
    const tx = txs[index];
    if (tx?.transaction.signatures[0] !== signature) continue;
    try {
      sample.set(signature, decodeTrades(tx, pool, coin));
    } catch {
      // Retry observations that cannot be decoded on this refresh.
    }
  }
  const trades = recent.flatMap(({ signature }) =>
    (sample.get(signature) ?? []).map((trade) => displayTrade(trade, coin))
  );
  const oldest = signatures.at(-1)?.blockTime ?? 0;
  const incomplete =
    sample.size !== recent.length ||
    signatures.some((sig) => sig.blockTime === null) ||
    (signatures.length === TX_LIMIT && oldest >= since);
  // A graduated snapshot samples its current pool; earlier DBC trades are outside this sample.
  const stats = summarizeMarket(
    trades,
    coin.marketCapSol,
    Boolean(coin.migratedPool) || incomplete,
    now
  );
  samplesByPool.set(key, {
    decoded: sample,
    quiet:
      trades.length === 0 && !incomplete
        ? {
            until: now + QUIET_POOL_TTL_SECONDS,
            reserve: coin.quoteReserveSol,
            price: coin.priceSol,
          }
        : undefined,
  });
  return stats;
}

async function samplePool(coin: Coin, now: number) {
  const key = poolSampleKey(coin);
  const previous = samplesByPool.get(key);
  const quiet = previous?.quiet;
  if (
    quiet &&
    now < quiet.until &&
    coin.quoteReserveSol === quiet.reserve &&
    coin.priceSol === quiet.price
  )
    return summarizeMarket([], coin.marketCapSol, Boolean(coin.migratedPool), now);
  if (previous) previous.quiet = undefined;
  const indexed = await mobulaMarketSample(coin, TX_LIMIT, now).catch((): null => null);
  return indexed ?? tokenStats(coin, now, key);
}

async function samplePools(coins: Coin[], now: number) {
  const active = new Set(coins.map(poolSampleKey));
  for (const key of samplesByPool.keys()) if (!active.has(key)) samplesByPool.delete(key);
  const tokens: Record<string, TokenMarket> = {};
  let next = 0;
  async function sampleNext() {
    for (let i = next++; i < coins.length; i = next++) {
      const coin = coins[i]!;
      try {
        tokens[coin.mint] = await samplePool(coin, now);
      } catch {
        /* Unavailable pools remain absent, rather than reporting a false zero. */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(POOL_CONCURRENCY, coins.length) }, sampleNext));
  return tokens;
}

async function loadMarket(): Promise<MarketStats> {
  const network = (async () => {
    const began = Date.now();
    const slot = await connection.getSlot('confirmed');
    const rpcMs = Date.now() - began;
    const samples = await connection.getRecentPerformanceSamples(1).catch((): PerfSample[] => []);
    const sample = samples[0];
    return {
      slot,
      rpcMs,
      tps:
        sample && sample.samplePeriodSecs > 0
          ? sample.numTransactions / sample.samplePeriodSecs
          : null,
    };
  })().catch((): MarketStats['network'] => ({ slot: null, rpcMs: null, tps: null }));
  const coins = await listCoins();
  const officialMint = BRAND.officialMint;
  const ordered = [...coins].sort(
    (a, b) =>
      Number(b.mint === officialMint) - Number(a.mint === officialMint) ||
      b.launchedAt - a.launchedAt
  );
  const tokens = await samplePools(ordered, Date.now() / 1000);
  const tracked = Object.values(tokens);
  return {
    updatedAt: Math.floor(Date.now() / 1000),
    network: await network,
    tokens,
    volumeSol: tracked.reduce((sum, token) => sum + token.volumeSol, 0),
    trades: tracked.reduce((sum, token) => sum + token.trades, 0),
    trackedPools: tracked.length,
    totalPools: coins.length,
    partial: tracked.length < coins.length || tracked.some((token) => token.partial),
  };
}

export async function getMarketStats(): Promise<MarketStats> {
  if (cached && Date.now() / 1000 - cached.updatedAt < TTL_MS / 1000) return cached;
  if (!pending)
    pending = loadMarket()
      .then((data) => {
        cached = data;
        return data;
      })
      .finally(() => {
        pending = null;
      });
  // An expired snapshot stays usable while the next refresh runs.
  if (cached) {
    void pending.catch(() => {});
    return cached;
  }
  const refresh = pending;
  if (!refresh) throw new Error('Market refresh did not start');
  const warming: MarketStats = {
    updatedAt: 0,
    network: { slot: null, rpcMs: null, tps: null },
    tokens: {},
    volumeSol: 0,
    trades: 0,
    trackedPools: 0,
    totalPools: 0,
    partial: true,
  };
  return new Promise<MarketStats>((resolve, reject) => {
    const timeout = setTimeout(() => resolve(warming), 6000);
    refresh.then(
      (data) => {
        clearTimeout(timeout);
        resolve(data);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}
