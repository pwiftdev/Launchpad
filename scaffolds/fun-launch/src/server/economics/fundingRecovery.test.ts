import { describe, it, expect, vi } from 'vitest';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { vaultAddresses, collectFeesInstruction } from '@/lib/vault/client';
import { fixtureGenesis, fixtureWallet, transactionFixture } from './financialFixtures';
import { messageDigest } from './chainEvidence';
import { verifyCollectedFundingRecovery, assertCollectedFundingRecovery } from './fundingRecovery';
import type { FinancialStore, FundingPlan } from './financialStore';
import type { OperatorPlan } from './operatorStore';

const shared = vi.hoisted(() => ({ state: null as unknown }));
vi.mock('./dammRealization', () => ({
  assertDammRealization: () => {},
  verifyDammRealization: async (args: {
    genesis: string;
    mint: string;
    pool: string;
    rawExpected: bigint;
  }) => ({
    networkGenesis: args.genesis,
    mint: args.mint,
    pool: args.pool,
    slot: 1000,
    source: 'collected',
    rawExpected: args.rawExpected,
    realizedNet: args.rawExpected - 1n,
    shortfall: 1n,
    externalLpExcluded: 0n,
    roundingLoss: 1n,
    digest: 'b'.repeat(64),
  }),
}));
vi.mock('./meteoraAdapter', () => ({
  MeteoraFinancialAdapter: class {
    async state() {
      return shared.state;
    }
  },
}));

describe('one-time collected-fee recovery', () => {
  it('preserves the exact event commitment/phase amounts and refuses a valid old hash, existing receipt or insufficient collected fees', async () => {
    const program = fixtureWallet().publicKey,
      mint = fixtureWallet().publicKey,
      operator = fixtureWallet(),
      addresses = vaultAddresses(program, mint);
    const funding: FundingPlan = {
      commitment: 'a'.repeat(64),
      fundingId: 'a'.repeat(64),
      lamports: 2000000n,
      pool: fixtureWallet().publicKey.toBase58(),
      migrated: true,
      sourceKind: 'damm_claim',
      events: [
        { id: { signature: 'event', instructionIndex: 0, eventIndex: 1 }, phase: 1, net: 2000000n },
      ],
      phases: [{ phase: 1, net: 2000000n }],
      allocation: { rinse_buyback: 0n, creator: 1000000n, community: 0n, platform: 1000000n },
    };
    const instruction = collectFeesInstruction({
      programId: program,
      mint,
      operator: operator.publicKey,
      dexProgram: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
      claimAccounts: Array.from({ length: 15 }, () => ({
        pubkey: fixtureWallet().publicKey,
        isSigner: false,
        isWritable: true,
      })),
      fundingId: funding.fundingId,
      commitment: funding.commitment,
      events: funding.phases,
      migrated: true,
    });
    const test = transactionFixture([instruction], operator);
    const plan: OperatorPlan = {
      id: 'id',
      network_genesis: fixtureGenesis,
      mint: mint.toBase58(),
      kind: 'funding',
      intent_key: 'funding:a',
      transaction_base64: test.tx.serialize().toString('base64'),
      message_digest: messageDigest(test.tx.serializeMessage()),
      last_valid_block_height: '900',
      metadata: {
        sourceKind: 'damm_claim',
        commitment: funding.commitment,
        events: funding.events.map((row) => row.id),
      },
      status: 'manual_review',
      signature: test.signature,
      finalized_slot: null,
    };
    const state = { slot: 1000, addresses, unallocatedCollected: 2000000n };
    shared.state = state;
    test.rpc.getBlockHeight = async () => 1001;
    test.rpc.isBlockhashValid = async () => ({ context: { slot: 1000 }, value: false });
    test.rpc.getAccountInfoAndContext = async () => ({ context: { slot: 1000 }, value: null });
    test.rpc.getLatestBlockhash = async () => ({
      blockhash: fixtureWallet().publicKey.toBase58(),
      lastValidBlockHeight: 1100,
    });
    const store = {
      previewFundingPlan: vi.fn(async () => funding),
      dammAccountedTotals: async () => ({
        accountedRealizedNet: 0n,
        accountedExternalLpExcluded: 0n,
        accountedRoundingLoss: 0n,
      }),
    } as unknown as FinancialStore;
    const input = { rpc: test.rpc, store, plan, program, operator: operator.publicKey };
    const proof = await verifyCollectedFundingRecovery(input);
    expect(() => assertCollectedFundingRecovery(proof)).not.toThrow();
    test.rpc.getAccountInfoAndContext = async () => ({
      context: { slot: 1000 },
      value: {
        owner: PublicKey.default,
        data: Buffer.alloc(0),
        lamports: 1,
        executable: false,
        rentEpoch: 0,
      },
    });
    expect((await verifyCollectedFundingRecovery(input)).amount).toBe(1999999n);
    expect(() => assertCollectedFundingRecovery({ ...proof })).toThrow('positive');
    const next = VersionedTransaction.deserialize(Buffer.from(proof.transactionBase64, 'base64'));
    expect(proof.oldCommitment).toBe(funding.commitment);
    expect(proof.commitment).not.toBe(funding.commitment);
    const nextData = Buffer.from(next.message.compiledInstructions[0]!.data);
    expect(nextData.subarray(8, 40).toString('hex')).toBe(proof.commitment);
    expect(nextData.readBigUInt64LE(75)).toBe(1999999n);
    expect(next.signatures.every((signature) => signature.every((byte) => byte === 0))).toBe(true);
    expect(proof.metadata.events).toEqual(plan.metadata.events);
    expect(proof.amount).toBe(1999999n);
    test.rpc.isBlockhashValid = async () => ({ context: { slot: 1000 }, value: true });
    await expect(verifyCollectedFundingRecovery(input)).rejects.toThrow('expired');
    test.rpc.isBlockhashValid = async () => ({ context: { slot: 1000 }, value: false });
    state.unallocatedCollected = 1999998n;
    await expect(verifyCollectedFundingRecovery(input)).rejects.toThrow('cover');
    state.unallocatedCollected = 2000000n;
    test.rpc.getAccountInfoAndContext = async () => ({
      context: { slot: 1000 },
      value: {
        owner: program,
        data: Buffer.alloc(138),
        lamports: 1,
        executable: false,
        rentEpoch: 0,
      },
    });
    await expect(verifyCollectedFundingRecovery(input)).rejects.toThrow('receipt exists');
  });
});
