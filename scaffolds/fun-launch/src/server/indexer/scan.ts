// Reads a pool's new swaps since its cursor, and walks back through older history in pages.
import { PublicKey, type Connection, type ConfirmedSignatureInfo } from '@solana/web3.js';
import type { Coin } from '@/lib/coin';
import { decodeTrades } from '../tradeDecoder';
import type { DisplayStore, IndexedTrade } from './store';

export type ScanRpc = Pick<Connection, 'getSignaturesForAddress' | 'getTransactions'>;
const PAGE = 1000;
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
 * One pass over a pool. New swaps are read oldest first and the cursor only moves past
 * transactions that were actually fetched, so a failed fetch is retried on the next pass.
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
    inserted = 0,
    more = false;

  // Forward: everything newer than the cursor, newest first from the RPC.
  const fresh: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await rpc.getSignaturesForAddress(
      address,
      { limit: PAGE, ...(newest ? { until: newest } : {}), ...(before ? { before } : {}) },
      'confirmed'
    );
    fresh.push(...page);
    if (page.length < PAGE || fresh.length >= FORWARD_BUDGET * 4) break;
    before = page.at(-1)!.signature;
  }
  if (!saved) {
    // First pass: the newest pages become the start of history; anything older is backfilled.
    backfillBefore = fresh.length >= PAGE ? fresh.at(-1)!.signature : null;
    complete = fresh.length < PAGE;
  }
  // Process the oldest new transactions first, within this pass's budget.
  const ordered = fresh.filter((sig) => !sig.err).reverse();
  const budget = ordered.slice(0, FORWARD_BUDGET);
  more = ordered.length > budget.length;
  for (const item of await decode(rpc, pool, coin, budget)) {
    if ('missing' in item) {
      more = true;
      break;
    }
    inserted += await store.insertTrades(coin.mint, item.trades);
    newest = item.signature;
  }
  // Failed transactions newer than the last processed one only move the cursor when nothing is pending.
  if (!more && fresh[0]) newest = fresh[0].signature;

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
      for (const item of decoded)
        if (!('missing' in item)) inserted += await store.insertTrades(coin.mint, item.trades);
      backfillBefore = page.at(-1)?.signature ?? backfillBefore;
      complete = page.length < BACKFILL_BUDGET;
    }
    more ||= !complete;
  }
  await store.saveCursor(pool, coin.mint, { newest, backfillBefore, complete });
  return { inserted, more };
}
