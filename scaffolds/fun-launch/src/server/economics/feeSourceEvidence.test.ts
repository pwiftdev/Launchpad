import { describe, it, expect, vi } from 'vitest';
import { Connection, MessageV1, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import fixture from '../fixtures/mainnet-v1-swap.json';
import {
  FinalizedFeeSourceReader,
  readFinalizedFeeEvidence,
  assertFeeEvidence,
  feeSourceInstructions,
} from './feeSourceEvidence';
import {
  FinalizedVerifier,
  assertFinalizedEvidence,
  allInstructions,
  lamportDelta,
  messageDigest,
} from './chainEvidence';
import { decodeFinalizedDbcFees } from './feeIngestion';
import { FinalizedFeeIndexer } from './finalizedIndexer';
import type { FinancialIndexCursor, FinancialStore } from './financialStore';
import { fixtureWallet, transactionFixture, fixtureGenesis } from './financialFixtures';
async function sample() {
  const json = structuredClone(fixture.response);
  const parser = new Connection('https://public-fixture.invalid', {
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: json }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const signature = json.transaction.signatures[0]!,
    tx = (await parser.getTransaction(signature, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 1,
    }))!;
  const genesis = fixture.source.networkGenesis,
    slot = tx.slot;
  const rpc = {
    getGenesisHash: vi.fn(async () => genesis),
    getSignatureStatuses: vi.fn(async () => ({
      context: { slot: slot + 10 },
      value: [{ confirmationStatus: 'finalized', slot: slot, err: null as unknown }],
    })),
    getTransaction: vi.fn(
      async (_signature: string, config: { maxSupportedTransactionVersion?: number }) => {
        if (config.maxSupportedTransactionVersion === 0)
          throw Object.assign(new Error('Unsupported transaction version'), { code: -32015 });
        return tx;
      }
    ),
  } as unknown as Connection;
  return {
    tx,
    rpc,
    signature,
    genesis,
    source: { ...fixture.source, mode: fixture.source.mode as 'creator' | 'community' },
  };
}
function indexHarness(
  rpc: Connection,
  source: Awaited<ReturnType<typeof sample>>['source'],
  signature: string
) {
  let cursor: FinancialIndexCursor = {
    network_genesis: source.networkGenesis,
    pool: source.pool,
    newest_signature: null,
    oldest_signature: null,
    complete: false,
    scan_head_signature: null,
    scan_before_signature: null,
    scan_until_signature: null,
    finalized_slot: '0',
    version: '0',
  };
  Object.assign(rpc, { getSignaturesForAddress: vi.fn(async () => [{ signature, err: null }]) });
  const store = {
    indexCursor: vi.fn(async () => ({ ...cursor })),
    ingestFinalizedFees: vi.fn(async (events: unknown[]) => events.length),
    advanceIndexCursor: vi.fn(async (next: FinancialIndexCursor) => {
      cursor = { ...next, version: String(BigInt(cursor.version) + 1n) };
      return cursor;
    }),
  };
  return {
    store,
    cursor: () => cursor,
    indexer: new FinalizedFeeIndexer(rpc, store as unknown as FinancialStore),
    options: { creationSignature: signature, route: 'dbc' as const, maximumPages: 1, pageSize: 10 },
  };
}
describe('separate finalized version-1 fee source observations', () => {
  it('keeps Bond it. DBC fees pre-bond when activation is expressed in slots rather than seconds', async () => {
    const f = await sample();
    const proof = await new FinalizedFeeSourceReader(f.rpc, f.genesis).transaction(f.signature);
    const events = decodeFinalizedDbcFees(proof, {
      ...f.source,
      mode: 'bond',
      activationPoint: f.tx.slot - 100,
    });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.phase).toBe(0);
      expect(event.allocation.creator).toBe(0n);
      expect(event.allocation.community).toBe(0n);
      const net = event.total - event.allocation.protocol - event.allocation.referral;
      expect(event.allocation.rinseBuyback).toBe((net * 95n) / 100n);
    }
  });
  it('decodes a real mainnet v1 swap without serializing it or granting signed-message receipt privileges', async () => {
    const f = await sample(),
      proof = await readFinalizedFeeEvidence(f.rpc, f.genesis, f.signature);
    expect(proof).toHaveProperty('kind', 'finalized-fee-source');
    expect(proof).not.toHaveProperty('messageDigest');
    expect(proof).not.toHaveProperty('transaction');
    expect(() => assertFinalizedEvidence(proof as never)).toThrow();
    expect(() => allInstructions(proof as never)).toThrow();
    expect(() => lamportDelta(proof as never, f.source.pool)).toThrow();
    expect(() => assertFeeEvidence({ ...proof })).toThrow();
    const events = decodeFinalizedDbcFees(proof, f.source);
    expect(events).toHaveLength(1);
    expect(events[0]!.total).toBeGreaterThan(0n);
    expect(Object.isFrozen(proof)).toBe(true);
    const a = feeSourceInstructions(proof),
      before = a[0]!.data.toString('base64');
    a[0]!.data.fill(0);
    expect(feeSourceInstructions(proof)[0]!.data.toString('base64')).toBe(before);
    const same = await new FinalizedFeeSourceReader(f.rpc, f.genesis).transaction(f.signature);
    expect(same.sourceCommitment).toEqual(
      'sourceCommitment' in proof ? proof.sourceCommitment : undefined
    );
  });
  it('keeps exact prepared transaction verification maxVersion0 and does not accept a v1 JSON hash as a message digest', async () => {
    const f = await sample();
    await expect(
      new FinalizedVerifier(f.rpc, f.genesis).transaction(f.signature, 'a'.repeat(64))
    ).rejects.toMatchObject({ code: -32015 });
    expect(
      vi
        .mocked(f.rpc.getTransaction)
        .mock.calls.map((call) => call[1]?.maxSupportedTransactionVersion)
    ).toEqual([0]);
  });
  it('preserves the original legacy proof and message digest without using the v1 fallback', async () => {
    const payer = fixtureWallet(),
      test = transactionFixture(
        [
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: fixtureWallet().publicKey,
            lamports: 1,
          }),
        ],
        payer
      ),
      proof = await readFinalizedFeeEvidence(test.rpc, fixtureGenesis, test.signature);
    expect(() => assertFinalizedEvidence(proof as never)).not.toThrow();
    expect(proof).toHaveProperty('messageDigest', messageDigest(test.tx.serializeMessage()));
  });
  it('indexes a finalized unrelated v1 donation as zero fees and advances only the proved boundary', async () => {
    const f = await sample(),
      payer = fixtureWallet(),
      donation = transactionFixture(
        [
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: fixtureWallet().publicKey,
            lamports: 1,
          }),
        ],
        payer
      ),
      legacy = donation.response.transaction.message;
    donation.response.transaction.message = new MessageV1({
      header: legacy.header,
      staticAccountKeys: legacy.staticAccountKeys,
      recentBlockhash: legacy.recentBlockhash,
      compiledInstructions: legacy.compiledInstructions,
    });
    donation.response.version = 1;
    vi.mocked(f.rpc.getTransaction).mockImplementation(async (_sig, config) => {
      if (config?.maxSupportedTransactionVersion === 0)
        throw Object.assign(new Error('Unsupported'), { code: -32015 });
      return donation.response;
    });
    vi.mocked(f.rpc.getSignatureStatuses).mockResolvedValue({
      context: { slot: donation.response.slot + 1 },
      value: [
        {
          slot: donation.response.slot,
          err: null,
          confirmationStatus: 'finalized',
          confirmations: null,
        },
      ],
    });
    const h = indexHarness(f.rpc, f.source, donation.signature),
      result = await h.indexer.runPool(f.source, h.options);
    expect(result).toMatchObject({ complete: true, events: 0, transactions: 1 });
    expect(h.store.advanceIndexCursor).toHaveBeenCalledOnce();
    expect(h.cursor().newest_signature).toBe(donation.signature);
  });
  it.each([
    'nonfinalized',
    'failed',
    'slot',
    'signature',
    'stale-context',
    'version',
    'account-index',
    'genesis',
  ] as const)('rejects %s evidence without advancing a financial cursor', async (kind) => {
    const f = await sample();
    if (kind === 'nonfinalized')
      vi.mocked(f.rpc.getSignatureStatuses).mockResolvedValue({
        context: { slot: f.tx.slot + 1 },
        value: [{ slot: f.tx.slot, err: null, confirmationStatus: 'confirmed', confirmations: 1 }],
      });
    if (kind === 'failed') f.tx.meta!.err = { InstructionError: [0, 'InvalidArgument'] };
    if (kind === 'slot') f.tx.slot++;
    if (kind === 'signature') f.tx.transaction.signatures[0] = fixtureWallet().publicKey.toBase58();
    if (kind === 'stale-context')
      vi.mocked(f.rpc.getSignatureStatuses).mockResolvedValue({
        context: { slot: 1 },
        value: [
          { slot: f.tx.slot, err: null, confirmationStatus: 'finalized', confirmations: null },
        ],
      });
    if (kind === 'version') (f.tx as unknown as { version: number }).version = 2;
    if (kind === 'account-index')
      f.tx.transaction.message.compiledInstructions[0]!.programIdIndex = 999;
    if (kind === 'genesis')
      vi.mocked(f.rpc.getGenesisHash)
        .mockResolvedValueOnce(f.genesis)
        .mockResolvedValueOnce(f.genesis)
        .mockResolvedValueOnce(f.genesis)
        .mockResolvedValue('wrong-network');
    const h = indexHarness(f.rpc, f.source, f.signature);
    await expect(h.indexer.runPool(f.source, h.options)).rejects.toThrow();
    expect(h.store.advanceIndexCursor).not.toHaveBeenCalled();
    expect(h.store.ingestFinalizedFees).not.toHaveBeenCalled();
  });
  it('does not silently skip a v1 swap whose execution events are missing', async () => {
    const f = await sample();
    f.tx.meta!.innerInstructions = f.tx.meta!.innerInstructions!.map((group) => ({
      ...group,
      instructions: group.instructions.filter(
        (ix) =>
          !Buffer.from(bs58.decode(ix.data))
            .subarray(0, 8)
            .equals(Buffer.from('e445a52e51cb9a1d', 'hex'))
      ),
    }));
    const h = indexHarness(f.rpc, f.source, f.signature);
    await expect(h.indexer.runPool(f.source, h.options)).rejects.toThrow('missing executed');
    expect(h.store.advanceIndexCursor).not.toHaveBeenCalled();
  });
});
