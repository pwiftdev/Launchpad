// Reads a pool's new swaps since its cursor, and walks back through older history in pages.
import { PublicKey, type Connection, type ConfirmedSignatureInfo } from '@solana/web3.js';
import type { Coin } from '@/lib/coin';
import { decodeTrades } from '../tradeDecoder';
import type { DisplayStore, IndexedTrade } from './store';

export type ScanRpc = Pick<Connection, 'getSignaturesForAddress' | 'getTransactions'>;
/** Transactions decoded per pool per pass; a busier pool continues on the next pass. */
const FORWARD_BUDGET = 400;
const BACKFILL_BUDGET = 200;
const BATCH = 20;

type Decoded = { signature: string; trades: IndexedTrade[] } | { signature: string; missing: true };

async function decode(
  rpc: ScanRpc,
  pool: string,
  coin: Coin,
  signatures: ConfirmedSignatureInfo[]
): Promise<Decoded[]> {
  const out: Decoded[] = [];
  for (let offset = 0; offset < signatures.length; offset += BATCH) {
    const batch = signatures.slice(offset, offset + BATCH);
    const rows = await rpc.getTransactions(
      batch.map((sig) => sig.signature),
      { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }
    );
    for (const [index, info] of batch.entries()) {
      const tx = rows[index];
      if (!tx || tx.transaction.signatures[0] !== info.signature) {
        out.push({ signature: info.signature, missing: true });
        continue;
      }
      let trades: IndexedTrade[] = [];
      try {
        trades = decodeTrades(tx, pool, coin).map((trade) => ({ ...trade, slot: tx.slot, pool }));
      } catch {
        // A transaction this decoder cannot read is skipped; display history never stalls on it.
        console.warn('Display indexer skipped an undecodable transaction');
      }
      out.push({ signature: info.signature, trades });
    }
  }
  return out;
}

/**
 * One pass over a pool. A busy pool walks a bounded window backwards and keeps its previous
 * cursor until every page in the window has been fetched and written.
 */
export async function scanPool(args: {
  rpc: ScanRpc;
  store: DisplayStore;
  pool: string;
  coin: Coin;
}): Promise<{ inserted: number; more: boolean }> {
  const { rpc, store, pool, coin } = args;
  const address = new PublicKey(pool);
  const saved = await store.cursor(pool);
  let newest = saved?.newest_signature ?? null,
    backfillBefore = saved?.backfill_before ?? null,
    complete = saved?.backfill_complete ?? false,
    forwardHead = saved?.forward_head ?? null,
    forwardBefore = saved?.forward_before ?? null,
    inserted = 0,
    more = false;

  const fresh = await rpc.getSignaturesForAddress(
    address,
    {
      limit: FORWARD_BUDGET,
      ...(newest ? { until: newest } : {}),
      ...(forwardBefore ? { before: forwardBefore } : {}),
    },
    'confirmed'
  );
  const full = fresh.length === FORWARD_BUDGET;
  const trades: IndexedTrade[] = [];
  let processed: string | undefined;
  for (const item of await decode(rpc, pool, coin, fresh.filter((sig) => !sig.err).reverse())) {
    if ('missing' in item) {
      more = true;
      break;
    }
    trades.push(...item.trades);
    processed = item.signature;
  }
  if (trades.length) inserted += await store.insertTrades(coin.mint, trades);
  if (more) {
    if (!full && !forwardHead && processed) {
      if (!newest && !backfillBefore) complete = true;
      newest = processed;
    }
  } else if (full && newest) {
    forwardHead ??= fresh[0]!.signature;
    forwardBefore = fresh.at(-1)!.signature;
    more = true;
  } else {
    if (!newest && !backfillBefore) {
      // A new pool starts with the newest page. Older history has its own cursor.
      backfillBefore = full ? fresh.at(-1)!.signature : null;
      complete = !full;
    }
    more = forwardHead !== null;
    newest = forwardHead ?? fresh[0]?.signature ?? newest;
    forwardHead = forwardBefore = null;
  }

  // Backfill: one page further back per pass until the pool's first transaction.
  if (!complete && backfillBefore) {
    const page = await rpc.getSignaturesForAddress(
      address,
      { limit: BACKFILL_BUDGET, before: backfillBefore },
      'confirmed'
    );
    const decoded = await decode(
      rpc,
      pool,
      coin,
      page.filter((sig) => !sig.err)
    );
    if (decoded.every((item) => !('missing' in item))) {
      const trades = decoded.flatMap((item) => ('missing' in item ? [] : item.trades));
      if (trades.length) inserted += await store.insertTrades(coin.mint, trades);
      backfillBefore = page.at(-1)?.signature ?? backfillBefore;
      complete = page.length < BACKFILL_BUDGET;
    }
    more ||= !complete;
  }
  await store.saveCursor(pool, coin.mint, {
    newest,
    backfillBefore,
    complete,
    forwardHead,
    forwardBefore,
  });
  return { inserted, more };
}
