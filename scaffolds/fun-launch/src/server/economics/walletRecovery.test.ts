import { describe, expect, it, vi } from 'vitest';
import { SystemProgram, type Connection } from '@solana/web3.js';
import {
  fixtureGenesis,
  fixtureWallet,
  transactionFixture,
  unsignedTransaction,
} from './financialFixtures';
import { messageDigest } from './chainEvidence';
import { assertWalletRecoveryProof, verifyWalletRecovery } from './walletRecovery';
import type { WalletJob } from './walletTypes';

function fixture() {
  // Use a single real signing identity for the persisted transfer.
  const payer = fixtureWallet(),
    signed = transactionFixture(
      [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: fixtureWallet().publicKey,
          lamports: 1,
        }),
      ],
      payer
    );
  const job = {
    id: 'test-expiry',
    network_genesis: fixtureGenesis,
    mint: fixtureWallet().publicKey.toBase58(),
    status: 'submitted',
    kind: 'creator_claim',
    transaction_base64: signed.tx.serialize().toString('base64'),
    message_digest: messageDigest(signed.tx.serializeMessage()),
    signature: signed.signature,
    prepared_slot: '1000',
    last_valid_block_height: '102',
  } as WalletJob;
  const slots = [1000, 1002, 1003, 1005],
    hashes = slots.map(() => fixtureWallet().publicKey.toBase58());
  const blocks = slots.map((slot, i) => ({
    slot,
    blockHeight: 100 + i,
    blockhash: hashes[i]!,
    parentSlot: i === 0 ? 999 : slots[i - 1]!,
    previousBlockhash: i === 0 ? fixtureWallet().publicKey.toBase58() : hashes[i - 1]!,
  }));
  const statuses = vi.fn(async () => ({ value: [null] })),
    getBlocks = vi.fn(async () => slots),
    getBlock = vi.fn(async (slot: number) => blocks.find((b) => b.slot === slot) ?? null);
  const getBlockSignatures = vi.fn(async (slot: number) => ({
    ...blocks.find((b) => b.slot === slot),
    signatures: ['another-signature'],
  }));
  const rpc = {
    getGenesisHash: vi.fn(async () => fixtureGenesis),
    getEpochInfo: vi.fn(async () => ({ absoluteSlot: 1010, blockHeight: 105 })),
    isBlockhashValid: vi.fn(async () => ({ context: { slot: 1010 }, value: false })),
    getSignatureStatuses: statuses,
    getTransaction: vi.fn(async () => null),
    getFirstAvailableBlock: vi.fn(async () => 900),
    getBlocks,
    getBlock,
    getBlockSignatures,
  } as unknown as Connection;
  return { rpc, job, signed, slots, blocks, getBlocks, getBlockSignatures, statuses };
}
describe('positive standard-wallet expiry recovery', () => {
  it('requires complete canonical block coverage and binds the exact original attempt', async () => {
    const f = fixture(),
      proof = await verifyWalletRecovery(f.rpc, f.job);
    expect(proof.signature).toBe(f.job.signature);
    expect(proof.blockCoverage.map((b) => b.blockHeight)).toEqual([100, 101, 102, 103]);
    expect(() => assertWalletRecoveryProof(proof)).not.toThrow();
    expect(() => assertWalletRecoveryProof({ ...proof })).toThrow('Independent');
  });
  it('refuses missing intermediate produced blocks despite missing signature status', async () => {
    const f = fixture();
    f.getBlocks.mockResolvedValue([1000, 1003, 1005]);
    await expect(verifyWalletRecovery(f.rpc, f.job)).rejects.toThrow('inconsistent finalized');
  });
  it('finds an already processed payout even when the status index returns null', async () => {
    const f = fixture();
    f.getBlockSignatures.mockImplementation(async (slot: number) => ({
      ...f.blocks.find((b) => b.slot === slot),
      signatures: slot === 1003 ? [f.job.signature!] : [],
    }));
    await expect(verifyWalletRecovery(f.rpc, f.job)).rejects.toThrow('found in retained history');
  });
  it('keeps the reservation if retained preparation history is pruned or the hash remains usable', async () => {
    const f = fixture();
    vi.mocked(f.rpc.getFirstAvailableBlock).mockResolvedValue(1001);
    await expect(verifyWalletRecovery(f.rpc, f.job)).rejects.toThrow('Retained wallet preparation');
    vi.mocked(f.rpc.getFirstAvailableBlock).mockResolvedValue(900);
    vi.mocked(f.rpc.isBlockhashValid).mockResolvedValue({ context: { slot: 1010 }, value: true });
    await expect(verifyWalletRecovery(f.rpc, f.job)).rejects.toThrow('still usable');
  });
  it('requires reconciliation for any observed execution or insufficient finalized height', async () => {
    const f = fixture();
    vi.mocked(f.rpc.getEpochInfo).mockResolvedValue({
      absoluteSlot: 1010,
      blockHeight: 102,
    } as never);
    await expect(verifyWalletRecovery(f.rpc, f.job)).rejects.toThrow('not positively expired');
    vi.mocked(f.rpc.getEpochInfo).mockResolvedValue({
      absoluteSlot: 1010,
      blockHeight: 105,
    } as never);
    vi.mocked(f.rpc.getTransaction).mockResolvedValue(f.signed.response);
    await expect(verifyWalletRecovery(f.rpc, f.job)).rejects.toThrow('Reconcile');
  });
  it('can refresh a never-signed attempt only after positive blockhash expiry', async () => {
    const f = fixture();
    f.job.status = 'prepared';
    f.job.signature = null;
    f.job.transaction_base64 = unsignedTransaction(f.signed.tx);
    const proof = await verifyWalletRecovery(f.rpc, f.job);
    expect(proof.blockCoverage).toEqual([]);
    expect(f.statuses).not.toHaveBeenCalled();
    f.job.transaction_base64 = f.signed.tx.serialize().toString('base64');
    await expect(verifyWalletRecovery(f.rpc, f.job)).rejects.toThrow('Signed bytes require');
  });
  it('refuses a changed RPC network after history checks', async () => {
    const f = fixture();
    vi.mocked(f.rpc.getGenesisHash)
      .mockResolvedValueOnce(fixtureGenesis)
      .mockResolvedValue('wrong-network');
    await expect(verifyWalletRecovery(f.rpc, f.job)).rejects.toThrow(
      'network or finalized bank changed'
    );
  });
});
