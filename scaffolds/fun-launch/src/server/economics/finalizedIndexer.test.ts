import { describe, expect, it, vi } from 'vitest';
import { type ConfirmedSignatureInfo, type Connection, SystemProgram } from '@solana/web3.js';
import { FinalizedFeeIndexer } from './finalizedIndexer';
import { type FinancialIndexCursor, type FinancialStore } from './financialStore';
import { fixtureGenesis, fixtureWallet, transactionFixture } from './financialFixtures';

function setup() {
  const pool = fixtureWallet().publicKey,
    payer = fixtureWallet();
  const history = Array.from({ length: 5 }, () =>
    transactionFixture(
      [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: pool, lamports: 1 })],
      payer
    )
  );
  const signatures = history.map(
    (test) =>
      ({
        signature: test.signature,
        slot: 1000,
        err: null,
        memo: null as string | null,
        blockTime: 3600,
        confirmationStatus: 'finalized',
      }) as ConfirmedSignatureInfo
  );
  const rpc = {
    getGenesisHash: async () => fixtureGenesis,
    getSignaturesForAddress: vi.fn(
      async (_address, options: { before?: string; limit?: number }) => {
        const start = options.before
          ? signatures.findIndex((item) => item.signature === options.before) + 1
          : 0;
        return signatures.slice(start, start + (options.limit ?? 1000));
      }
    ),
    getSignatureStatuses: async (items: string[]) => ({
      context: { slot: 1000 },
      value: items.map(() => ({
        slot: 1000,
        err: null as ConfirmedSignatureInfo['err'],
        confirmations: null as number | null,
        confirmationStatus: 'finalized',
      })),
    }),
    getTransaction: async (signature: string) =>
      history.find((test) => test.signature === signature)?.response ?? null,
  } as unknown as Connection;
  let cursor: FinancialIndexCursor = {
    network_genesis: fixtureGenesis,
    pool: pool.toBase58(),
    newest_signature: null,
    oldest_signature: null,
    complete: false,
    scan_head_signature: null,
    scan_before_signature: null,
    scan_until_signature: null,
    finalized_slot: '0',
    version: '0',
  };
  const store = {
    indexCursor: vi.fn(async () => ({ ...cursor })),
    ingestFinalizedFees: vi.fn(async () => 0),
    advanceIndexCursor: vi.fn(async (next: FinancialIndexCursor) => {
      if (next.version !== cursor.version) throw new Error('stale cursor');
      cursor = { ...next, version: String(BigInt(cursor.version) + 1n) };
      return { ...cursor };
    }),
  };
  const source = {
    networkGenesis: fixtureGenesis,
    pool: pool.toBase58(),
    mint: fixtureWallet().publicKey.toBase58(),
    configKey: fixtureWallet().publicKey.toBase58(),
    activationPoint: 1000,
    mode: 'creator' as const,
  };
  return {
    history,
    signatures,
    rpc,
    store,
    source,
    cursor: () => cursor,
    indexer: new FinalizedFeeIndexer(rpc, store as unknown as FinancialStore),
  };
}

describe('resumable finalized fee indexing', () => {
  it('pauses bounded scans without claiming completeness, then continues through the proved creation signature', async () => {
    const test = setup(),
      options = {
        creationSignature: test.history.at(-1)!.signature,
        route: 'dbc' as const,
        maximumPages: 1,
        pageSize: 2,
      };
    expect(await test.indexer.runPool(test.source, options)).toMatchObject({
      paused: true,
      complete: false,
      transactions: 2,
    });
    expect(await test.indexer.runPool(test.source, options)).toMatchObject({
      paused: true,
      complete: false,
      transactions: 2,
    });
    expect(await test.indexer.runPool(test.source, options)).toMatchObject({
      paused: false,
      complete: true,
      transactions: 1,
    });
    expect(test.cursor().newest_signature).toBe(test.history[0]!.signature);
    expect(await test.indexer.runPool(test.source, options)).toMatchObject({
      paused: false,
      complete: true,
      transactions: 0,
    });
  });
  it('does not advance past a missing transaction or silently treat an archival gap as complete', async () => {
    const test = setup(),
      original = test.rpc.getTransaction.bind(test.rpc);
    test.rpc.getTransaction = async (signature, ...rest) =>
      signature === test.history[1]!.signature ? null : original(signature, ...rest);
    const options = {
      creationSignature: test.history.at(-1)!.signature,
      route: 'dbc' as const,
      maximumPages: 1,
      pageSize: 2,
    };
    await expect(test.indexer.runPool(test.source, options)).rejects.toThrow('finalized');
    expect(test.cursor().version).toBe('0');
    test.rpc.getTransaction = original;
    expect(await test.indexer.runPool(test.source, options)).toMatchObject({
      paused: true,
      complete: false,
    });
    const missing = setup();
    await expect(
      missing.indexer.runPool(missing.source, {
        ...options,
        creationSignature: null,
        maximumPages: 10,
      })
    ).rejects.toThrow('unproved');
    expect(missing.cursor().complete).toBe(false);
  });
});
