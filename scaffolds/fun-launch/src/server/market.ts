import { PublicKey, type PerfSample } from '@solana/web3.js';
import { BRAND } from '@/constants/brand';
import { connection, listCoins } from './dbc';
import { decodeTrades } from './trades';
import { displayTrade } from './tradeDecoder';
import { mobulaMarketSample } from './mobulaMarket';
import { summarizeMarket, type MarketStats, type TokenMarket } from '@/lib/market';
import type { Coin, Trade } from '@/lib/coin';

const TTL_MS = 60_000;
const POOL_LIMIT = 8;
const TX_LIMIT = 24;
const samplesByPool = new Map<string, Map<string, Trade[]>>();
let cached: MarketStats | null = null;
let pending: Promise<MarketStats> | null = null;

async function tokenStats(coin: Coin, now: number): Promise<TokenMarket> {
  const pool = coin.migratedPool ?? coin.pool;
  const since = Math.floor(now) - 86400;
  const signatures = await connection.getSignaturesForAddress(
    new PublicKey(pool),
    { limit: TX_LIMIT },
    'confirmed'
  );
  const recent = signatures.filter((sig) => !sig.err && (sig.blockTime ?? 0) >= since);
  const key = `${pool}:${coin.tokenDecimals}:${coin.migratedBaseIsA}:${coin.dbcCollectFeeMode}`;
  const previous = samplesByPool.get(key);
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
  samplesByPool.delete(key);
  if (samplesByPool.size >= 64) samplesByPool.delete(samplesByPool.keys().next().value!);
  samplesByPool.set(key, sample);
  const trades = recent.flatMap(({ signature }) =>
    (sample.get(signature) ?? []).map((trade) => displayTrade(trade, coin))
  );
  const incomplete =
    sample.size !== recent.length || signatures.some((sig) => sig.blockTime === null);
  const oldest = signatures.at(-1)?.blockTime ?? 0;
  // A graduated snapshot samples its current pool; earlier DBC trades are outside this sample.
  const partial =
    Boolean(coin.migratedPool) || incomplete || (signatures.length === TX_LIMIT && oldest >= since);
  return summarizeMarket(trades, coin.marketCapSol, partial, now);
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
  // Keep page traffic bounded even if the launchpad grows: at most 192 transaction reads/minute.
  const officialMint = BRAND.officialMint;
  const selected = [...coins]
    .sort(
      (a, b) =>
        Number(b.mint === officialMint) - Number(a.mint === officialMint) ||
        b.launchedAt - a.launchedAt
    )
    .slice(0, POOL_LIMIT);
  const now = Date.now() / 1000;
  const indexed = selected.map((coin) =>
    mobulaMarketSample(coin, TX_LIMIT, now).catch((): null => null)
  );
  const tokens: Record<string, TokenMarket> = {};
  for (let i = 0; i < selected.length; i += 2) {
    await Promise.all(
      selected.slice(i, i + 2).map(async (coin, offset) => {
        try {
          tokens[coin.mint] = (await indexed[i + offset]) ?? (await tokenStats(coin, now));
        } catch {
          /* Unavailable pools remain absent, rather than reporting a false zero. */
        }
      })
    );
  }
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
