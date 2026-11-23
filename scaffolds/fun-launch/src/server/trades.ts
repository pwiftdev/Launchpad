// Display-only confirmed history. Financial workers use their separate finalized journal.
import { PublicKey } from '@solana/web3.js';
import type { Trade } from '@/lib/coin';
import { TOKEN_DECIMALS, TOTAL_SUPPLY } from '@/constants/launch';
import { connection } from './dbc';
import { decodeTrades, type TokenContext } from './tradeDecoder';
export { decodeTrade, decodeTrades } from './tradeDecoder';
const REFRESH_MS = 2_000,
  PAGE = 100,
  MAX_KEPT_TRADES = 2000,
  MAX_RETRY = 200;
export type TradeHistory = {
  trades: Trade[];
  complete: boolean;
  updatedAt?: number;
  stale?: boolean;
  pendingCount?: number;
};
type Cache = {
  trades: Trade[];
  newestSig?: string;
  oldestSig?: string;
  baselineComplete: boolean;
  lost: boolean;
  scanned: number;
  retry: Set<string>;
  /** RPC discovery order (newest first), retained for trades and pending retries only. */
  signatureOrder: string[];
  at: number;
  retryAt: number;
  dirty?: boolean;
  pending?: Promise<TradeHistory>;
};
const cache = new Map<string, Cache>();
const keyFor = (pool: string, token: TokenContext) =>
  `${pool}:${token.tokenDecimals ?? TOKEN_DECIMALS}:${token.migratedBaseIsA}:${token.dbcCollectFeeMode}`;
function view(entry: Cache, token: TokenContext, stale = false): TradeHistory {
  const supply = token.tokenSupply ?? TOTAL_SUPPLY;
  return {
    trades: entry.trades.map((trade) => {
      const rate = token.quoteToSol ?? 1;
      return { ...trade, sol: trade.sol * rate, feeSol: trade.feeSol * rate, priceSol: trade.priceSol * rate, marketCapSol: trade.priceSol * rate * supply };
    }),
    complete: entry.baselineComplete && !entry.lost && !entry.retry.size,
    updatedAt: Math.floor(entry.at / 1000),
    stale,
    pendingCount: entry.retry.size,
  };
}
/** Live logs invalidate only display caches, never financial observations. */
export function invalidateTradeHistory(pool: string) {
  for (const [key, entry] of cache)
    if (key.startsWith(pool + ':')) {
      entry.dirty = true;
      entry.retryAt = 0;
    }
}
async function decodeAll(pool: string, sigs: string[], token: TokenContext) {
  const perSignature = new Map<string, Trade[]>(),
    missing = new Set<string>();
  let received = 0,
    transportFailures = 0;
  // Small RPC batches avoid provider payload limits. At most two batches are in flight per pool.
  for (let offset = 0; offset < sigs.length; offset += 40)
    await Promise.all(
      [sigs.slice(offset, offset + 20), sigs.slice(offset + 20, offset + 40)]
        .filter((batch) => batch.length)
        .map(async (batch) => {
          let rows;
          try {
            rows = await connection.getTransactions(batch, {
              commitment: 'confirmed',
              maxSupportedTransactionVersion: 1,
            });
          } catch {
            transportFailures++;
            for (const sig of batch) missing.add(sig);
            return;
          }
          if (rows.length !== batch.length) {
            for (const sig of batch) missing.add(sig);
            return;
          }
          rows.forEach((tx, index) => {
            const sig = batch[index]!;
            if (!tx || tx.transaction.signatures[0] !== sig) {
              missing.add(sig);
              return;
            }
            received++;
            try {
              perSignature.set(sig, decodeTrades(tx, pool, token));
            } catch {
              missing.add(sig);
            }
          });
        })
    );
  if (sigs.length && !received && transportFailures && missing.size === sigs.length)
    throw new Error('Trade transactions are temporarily unavailable');
  return {
    trades: sigs.flatMap((sig) => perSignature.get(sig) ?? []),
    missing: sigs.filter((sig) => missing.has(sig)),
  };
}
/** Latest page first; older pages backfill incrementally instead of blocking opening a token. */
export async function getTradeHistory(
  pool: string,
  token: TokenContext = {}
): Promise<TradeHistory> {
  const key = keyFor(pool, token);
  let entry = cache.get(key);
  const now = Date.now();
  if (entry?.pending) {
    try {
      await entry.pending;
    } catch (error) {
      if (!entry.at) throw error;
    }
    return view(entry, token, entry.retryAt > Date.now());
  }
  if (entry && ((!entry.dirty && now - entry.at < REFRESH_MS) || entry.retryAt > now))
    return view(entry, token, entry.retryAt > now);
  if (!entry) {
    if (cache.size >= 32) {
      const idle = [...cache].find(([, e]) => !e.pending)?.[0];
      if (!idle) throw new Error('Trade history service is busy');
      cache.delete(idle);
    }
    entry = {
      trades: [],
      baselineComplete: false,
      lost: false,
      scanned: 0,
      retry: new Set(),
      signatureOrder: [],
      at: 0,
      retryAt: 0,
    };
    cache.set(key, entry);
  }
  const current = entry;
  const pending = (async () => {
    const address = new PublicKey(pool),
      first = await connection.getSignaturesForAddress(
        address,
        { limit: PAGE, until: current.newestSig },
        'confirmed'
      );
    const recent = [...first],
      before = first.at(-1)?.signature;
    let recentComplete = first.length < PAGE;
    // Bound bursts; a capped burst remains explicitly partial rather than silently claiming complete history.
    if (current.newestSig && first.length === PAGE) {
      const next = await connection.getSignaturesForAddress(
        address,
        { limit: PAGE, until: current.newestSig, before },
        'confirmed'
      );
      recent.push(...next);
      recentComplete = next.length < PAGE;
    }
    let older: typeof first = [];
    if (
      current.newestSig &&
      !current.baselineComplete &&
      current.oldestSig &&
      current.scanned < MAX_KEPT_TRADES
    ) {
      older = await connection.getSignaturesForAddress(
        address,
        { limit: PAGE, before: current.oldestSig },
        'confirmed'
      );
    }
    const selected = [
      ...new Set(
        [...recent, ...older]
          .filter((sig) => !sig.err)
          .map((sig) => sig.signature)
          .concat([...current.retry].slice(0, 40))
      ),
    ];
    const decoded = await decodeAll(pool, selected, token),
      combined = [...decoded.trades, ...current.trades],
      unique = new Map<string, Trade>();
    // Preserve the provider's discovered signature order across late transaction reads.
    // This is display ordering, not an asserted canonical execution order within a slot.
    const signatureOrder = [
      ...new Set([
        ...recent.map((row) => row.signature),
        ...current.signatureOrder,
        ...older.map((row) => row.signature),
        ...selected,
      ]),
    ];
    const rank = new Map(signatureOrder.map((sig, index) => [sig, index]));
    for (const trade of combined)
      unique.set(
        trade.id ?? `${trade.sig}:${trade.instructionIndex ?? 0}:${trade.eventIndex ?? 0}`,
        trade
      );
    current.trades = [...unique.values()]
      .sort(
        (a, b) =>
          b.ts - a.ts ||
          (a.sig === b.sig
            ? (b.instructionIndex ?? 0) - (a.instructionIndex ?? 0) ||
              (b.eventIndex ?? 0) - (a.eventIndex ?? 0)
            : (rank.get(a.sig) ?? Infinity) - (rank.get(b.sig) ?? Infinity))
      )
      .slice(0, MAX_KEPT_TRADES);
    for (const sig of selected) current.retry.delete(sig);
    for (const sig of decoded.missing) {
      if (current.retry.size < MAX_RETRY) current.retry.add(sig);
      else current.lost = true;
    }
    const retained = new Set(current.trades.map((trade) => trade.sig));
    current.signatureOrder = signatureOrder.filter(
      (sig) => retained.has(sig) || current.retry.has(sig)
    );
    if (!current.newestSig) {
      current.oldestSig = first.at(-1)?.signature;
      current.baselineComplete = first.length < PAGE;
      current.scanned = first.length;
    } else if (older.length || (!current.baselineComplete && current.oldestSig)) {
      current.oldestSig = older.at(-1)?.signature ?? current.oldestSig;
      current.baselineComplete = older.length < PAGE;
      current.scanned += older.length;
    }
    if (current.newestSig && !recentComplete) current.lost = true;
    if (
      unique.size > MAX_KEPT_TRADES ||
      (current.scanned >= MAX_KEPT_TRADES && !current.baselineComplete)
    )
      current.lost = true;
    current.newestSig = first[0]?.signature ?? current.newestSig;
    current.at = Date.now();
    current.retryAt = 0;
    current.dirty = false;
    return view(current, token);
  })();
  current.pending = pending;
  try {
    return await pending;
  } catch (error) {
    current.retryAt = Date.now() + REFRESH_MS;
    if (current.at) return view(current, token, true);
    throw error;
  } finally {
    delete current.pending;
  }
}
export async function recentTxCount(pool: string, seconds: number): Promise<number> {
  const since = Math.floor(Date.now() / 1000) - seconds;
  const rows = await connection.getSignaturesForAddress(
    new PublicKey(pool),
    { limit: 100 },
    'confirmed'
  );
  return rows.filter((sig) => !sig.err && (sig.blockTime ?? 0) >= since).length;
}
