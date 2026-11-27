import { describe, expect, it, vi } from 'vitest';
import type { ConfirmedSignatureInfo, VersionedTransactionResponse } from '@solana/web3.js';
import type { Coin } from '@/lib/coin';
import type { DisplayStore, IndexedTrade } from './store';

vi.mock('../tradeDecoder', () => ({
  decodeTrades: (tx: VersionedTransactionResponse) => {
    const signature = tx.transaction.signatures[0]!;
    if (signature.startsWith('bad')) throw new Error('undecodable');
    return [
      {
        sig: signature,
        ts: 1,
        side: 'buy',
        wallet: 'w',
        sol: 1,
        tokens: 1,
        feeSol: 0,
        priceSol: 1,
        marketCapSol: 1,
      },
    ];
  },
}));
import { scanPool } from './scan';

const POOL = '11111111111111111111111111111111';
const coin = { mint: 'So11111111111111111111111111111111111111112', pool: POOL } as Coin;
const sig = (n: number, err: unknown = null) =>
  ({ signature: `sig-${n}`, err, slot: n, blockTime: n }) as ConfirmedSignatureInfo;
const tx = (signature: string) =>
  ({
    slot: 1,
    transaction: { signatures: [signature] },
  }) as unknown as VersionedTransactionResponse;

/** A chain with signatures 1..count, newest first like the RPC, and a memory store. */
function fixture(count: number, missing = new Set<string>()) {
  const all = Array.from({ length: count }, (_, i) => sig(count - i));
  const rpc = {
    getSignaturesForAddress: vi.fn(
      async (_: unknown, options: { limit: number; until?: string; before?: string }) => {
        let list = all;
        if (options.before)
          list = list.slice(list.findIndex((s) => s.signature === options.before) + 1);
        if (options.until) {
          const stop = list.findIndex((s) => s.signature === options.until);
          if (stop >= 0) list = list.slice(0, stop);
        }
        return list.slice(0, options.limit);
      }
    ),
    getTransactions: vi.fn(async (signatures: string[]) =>
      signatures.map((s) => (missing.has(s) ? null : tx(s)))
    ),
  };
  const inserted: string[] = [];
  let cursor:
    | {
        newest_signature: string | null;
        backfill_before: string | null;
        backfill_complete: boolean;
        forward_head: string | null;
        forward_before: string | null;
      }
    | undefined;
  const store = {
    cursor: vi.fn(async () => cursor),
    saveCursor: vi.fn(
      async (_: string, __: string, c: Parameters<DisplayStore['saveCursor']>[2]) => {
        cursor = {
          newest_signature: c.newest,
          backfill_before: c.backfillBefore,
          backfill_complete: c.complete,
          forward_head: c.forwardHead,
          forward_before: c.forwardBefore,
        };
      }
    ),
    insertTrades: vi.fn(async (_: string, trades: IndexedTrade[]) => {
      inserted.push(...trades.map((t) => t.sig));
      return trades.length;
    }),
  } as unknown as DisplayStore;
  return {
    rpc,
    store,
    inserted,
    cursor: () => cursor,
    addSignatures(total: number) {
      const count = all.length;
      all.unshift(...Array.from({ length: total - count }, (_, i) => sig(total - i)));
    },
  };
}

describe('pool scan', () => {
  it('reads a small pool completely in one pass, oldest first', async () => {
    const f = fixture(5);
    const result = await scanPool({ rpc: f.rpc as never, store: f.store, pool: POOL, coin });
    expect(f.inserted).toEqual(['sig-1', 'sig-2', 'sig-3', 'sig-4', 'sig-5']);
    expect(result).toEqual({ inserted: 5, more: false });
    expect(f.cursor()).toEqual({
      newest_signature: 'sig-5',
      backfill_before: null,
      backfill_complete: true,
      forward_head: null,
      forward_before: null,
    });
    // Nothing new: the next pass asks only for signatures after the cursor.
    await scanPool({ rpc: f.rpc as never, store: f.store, pool: POOL, coin });
    expect(f.inserted).toHaveLength(5);
  });

  it('never moves the cursor past a transaction it could not fetch', async () => {
    const f = fixture(5, new Set(['sig-3']));
    const result = await scanPool({ rpc: f.rpc as never, store: f.store, pool: POOL, coin });
    expect(f.inserted).toEqual(['sig-1', 'sig-2']);
    expect(result.more).toBe(true);
    expect(f.cursor()!.newest_signature).toBe('sig-2');
  });

  it('skips failed and undecodable transactions without stalling', async () => {
    const f = fixture(3);
    f.rpc.getSignaturesForAddress.mockResolvedValueOnce([
      sig(3),
      sig(2, { InstructionError: [] }),
      sig(1),
    ]);
    await scanPool({ rpc: f.rpc as never, store: f.store, pool: POOL, coin });
    expect(f.inserted).toEqual(['sig-1', 'sig-3']);
    expect(f.cursor()!.newest_signature).toBe('sig-3');
  });

  it('starts a long pool at its newest pages and walks back until its first swap', async () => {
    const f = fixture(2600);
    let passes = 0,
      more = true;
    while (more && passes++ < 50)
      ({ more } = await scanPool({ rpc: f.rpc as never, store: f.store, pool: POOL, coin }));
    expect(passes).toBeLessThan(15);
    expect(f.cursor()!.backfill_complete).toBe(true);
    expect(new Set(f.inserted).size).toBe(2600);
    expect(f.cursor()!.newest_signature).toBe('sig-2600');
  });

  it('resumes an established cursor through a backlog and an uncertain write', async () => {
    const unavailable = new Set(['sig-2010']);
    const f = fixture(1, unavailable);
    const pass = () => scanPool({ rpc: f.rpc as never, store: f.store, pool: POOL, coin });
    await pass();
    f.addSignatures(2600);
    const insert = vi.mocked(f.store.insertTrades).getMockImplementation()!;
    vi.mocked(f.store.insertTrades).mockImplementationOnce(async (mint, trades) => {
      await insert(mint, trades);
      throw new Error('connection lost after database accepted trades');
    });
    await expect(pass()).rejects.toThrow('connection lost');
    expect(f.cursor()!.newest_signature).toBe('sig-1');
    await pass();
    expect(f.cursor()).toMatchObject({
      newest_signature: 'sig-1',
      forward_head: 'sig-2600',
      forward_before: 'sig-2201',
    });
    await pass();
    expect(f.cursor()!.forward_before).toBe('sig-2201');
    unavailable.clear();
    f.addSignatures(2700);
    let more = true;
    for (let i = 0; i < 15 && more; i++) ({ more } = await pass());
    expect(more).toBe(false);
    expect(new Set(f.inserted).size).toBe(2700);
    expect(f.cursor()).toMatchObject({
      newest_signature: 'sig-2700',
      forward_head: null,
      forward_before: null,
    });
  });
});
