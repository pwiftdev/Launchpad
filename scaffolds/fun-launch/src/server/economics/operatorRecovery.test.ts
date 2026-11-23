import { describe, expect, it } from 'vitest';
import { SystemProgram, VersionedTransaction } from '@solana/web3.js';
import {
  fixtureGenesis,
  fixtureWallet,
  transactionFixture,
  unsignedTransaction,
} from './financialFixtures';
import { messageDigest } from './chainEvidence';
import { assertOperatorRefresh, verifyOperatorRefresh } from './operatorRecovery';
import type { OperatorPlan } from './operatorStore';

describe('unsigned operator refresh', () => {
  it('proves finalized expiry and replaces only the blockhash, retaining the exact instruction and authority', async () => {
    const wallet = fixtureWallet(),
      mint = fixtureWallet().publicKey,
      program = fixtureWallet().publicKey;
    const fixture = transactionFixture(
      [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: mint, lamports: 1 })],
      wallet
    );
    const unsigned = unsignedTransaction(fixture.tx),
      old = VersionedTransaction.deserialize(Buffer.from(unsigned, 'base64'));
    const plan: OperatorPlan = {
      id: 'plan',
      network_genesis: fixtureGenesis,
      mint: mint.toBase58(),
      kind: 'funding',
      intent_key: 'funding:test',
      transaction_base64: unsigned,
      message_digest: messageDigest(old.message.serialize()),
      last_valid_block_height: '1000',
      metadata: { commitment: 'a'.repeat(64) },
      status: 'prepared',
      signature: null,
      finalized_slot: null,
    };
    fixture.rpc.getBlockHeight = async () => 1001;
    fixture.rpc.isBlockhashValid = async () => ({ context: { slot: 1000 }, value: false });
    fixture.rpc.getAccountInfoAndContext = async () => ({ context: { slot: 1000 }, value: null });
    const nextHash = fixtureWallet().publicKey.toBase58();
    fixture.rpc.getLatestBlockhash = async () => ({
      blockhash: nextHash,
      lastValidBlockHeight: 1100,
    });
    const proof = await verifyOperatorRefresh(fixture.rpc, plan, program.toBase58());
    expect(() => assertOperatorRefresh(proof)).not.toThrow();
    expect(() => assertOperatorRefresh({ ...proof })).toThrow('independently');
    const fresh = VersionedTransaction.deserialize(Buffer.from(proof.transactionBase64, 'base64'));
    expect(fresh.message.recentBlockhash).toBe(nextHash);
    fresh.message.recentBlockhash = old.message.recentBlockhash;
    expect(Buffer.from(fresh.serialize())).toEqual(Buffer.from(unsigned, 'base64'));
    await expect(
      verifyOperatorRefresh(
        fixture.rpc,
        { ...plan, signature: fixture.signature, status: 'manual_review' },
        program.toBase58()
      )
    ).rejects.toThrow('unsigned');
    fixture.rpc.isBlockhashValid = async () => ({ context: { slot: 1000 }, value: true });
    await expect(verifyOperatorRefresh(fixture.rpc, plan, program.toBase58())).rejects.toThrow(
      'definitively'
    );
    fixture.rpc.isBlockhashValid = async () => ({ context: { slot: 1000 }, value: false });
    fixture.rpc.getAccountInfoAndContext = async () => ({
      context: { slot: 1000 },
      value: {
        data: Buffer.alloc(138),
        owner: program,
        lamports: 1,
        executable: false,
        rentEpoch: 0,
      },
    });
    await expect(verifyOperatorRefresh(fixture.rpc, plan, program.toBase58())).rejects.toThrow(
      'already exist'
    );
  });
});
