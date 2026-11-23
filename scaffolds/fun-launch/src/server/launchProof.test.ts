import { BorshCoder, type Idl } from '@coral-xyz/anchor';
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import {
  DynamicBondingCurveIdl,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { NATIVE_MINT } from '@solana/spl-token';
import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { registerCoinInstruction } from '@/lib/vault/client';
import { proveLaunchCreation } from './launchProof';

const coder = new BorshCoder(DynamicBondingCurveIdl as unknown as Idl);
function fixture(mode: 'creator' | 'community' = 'community', includeVault = true) {
  const creator = Keypair.generate(),
    mint = Keypair.generate(),
    config = Keypair.generate().publicKey,
    pool = Keypair.generate().publicKey,
    program = Keypair.generate().publicKey;
  const definition = DynamicBondingCurveIdl.instructions.find(
    (i) => i.name === 'initialize_virtual_pool_with_spl_token'
  );
  if (!definition) throw new Error('Missing fixture definition');
  const named: Record<string, PublicKey> = {
    creator: creator.publicKey,
    payer: creator.publicKey,
    base_mint: mint.publicKey,
    quote_mint: NATIVE_MINT,
    config,
    pool,
  };
  const instruction = new TransactionInstruction({
    programId: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
    keys: definition.accounts.map((a) => ({
      pubkey:
        named[a.name] ??
        ('address' in a && a.address ? new PublicKey(a.address) : Keypair.generate().publicKey),
      isSigner: Boolean('signer' in a && a.signer),
      isWritable: Boolean('writable' in a && a.writable),
    })),
    data: coder.instruction.encode(definition.name, {
      params: { name: 'Example', symbol: 'TEST', uri: 'ipfs://example' },
    }),
  });
  const tx = new Transaction({
    feePayer: creator.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(instruction);
  if (includeVault)
    tx.add(
      registerCoinInstruction({
        programId: program,
        mint: mint.publicKey,
        pool,
        config,
        creator: creator.publicKey,
        mode,
      })
    );
  tx.partialSign(creator, mint);
  const proof = {
    slot: 100,
    blockTime: 1_000,
    meta: { err: null, loadedAddresses: { writable: [], readonly: [] } },
    transaction: { signatures: [bs58.encode(tx.signature!)], message: tx.compileMessage() },
  } as unknown as VersionedTransactionResponse;
  const expected = {
    mint: mint.publicKey.toBase58(),
    pool: pool.toBase58(),
    config: config.toBase58(),
    deployer: creator.publicKey.toBase58(),
    intentCreatedAt: 999_000,
    intentExpiresAt: 1_100_000,
    preparedSlot: '99',
    vaultProgram: program,
    mode,
  };
  return { proof, expected };
}
describe('immutable launch confirmation proof', () => {
  it('proves wallet-v1 launch from signed creator/mint/config and immutable intent without native registration', () => {
    const { proof, expected } = fixture('creator', false),
      walletExpected = {
        ...expected,
        vaultProgram: undefined as PublicKey | undefined,
        policyVersion: 'wallet-v1' as const,
      };
    expect(proveLaunchCreation(proof, walletExpected).creator).toBe(expected.deployer);
    expect(proveLaunchCreation({ ...proof, blockTime: 2000 }, walletExpected).creator).toBe(
      expected.deployer
    );
    expect(() => proveLaunchCreation(proof, { ...walletExpected, preparedSlot: '0' })).toThrow(
      'preparation slot'
    );
    expect(() => proveLaunchCreation({ ...proof, slot: 98 }, walletExpected)).toThrow(
      'preparation slot'
    );
    expect(() => proveLaunchCreation(proof, { ...walletExpected, mode: undefined })).toThrow(
      'signed mode'
    );
    expect(() =>
      proveLaunchCreation(proof, {
        ...walletExpected,
        deployer: Keypair.generate().publicKey.toBase58(),
      })
    ).toThrow();
  });
  it('proves original creator and mode from atomic signed creation, rather than mutable metadata', () => {
    const { proof, expected } = fixture();
    expect(proveLaunchCreation(proof, expected).creator).toBe(expected.deployer);
  });
  it('rejects a registered mode different from the wallet-signed intent', () => {
    const { proof, expected } = fixture();
    expect(() => proveLaunchCreation(proof, { ...expected, mode: 'creator' })).toThrow(
      'registration'
    );
  });
  it('requires custody registration in the same successful creation transaction', () => {
    const { proof, expected } = fixture('creator', false);
    expect(() => proveLaunchCreation(proof, expected)).toThrow('registration');
  });
  it('rejects an unrelated pool, config, deployer or failed creation', () => {
    const { proof, expected } = fixture();
    for (const key of ['mint', 'pool', 'config', 'deployer'])
      expect(() =>
        proveLaunchCreation(proof, { ...expected, [key]: Keypair.generate().publicKey.toBase58() })
      ).toThrow();
    expect(() =>
      proveLaunchCreation(
        { ...proof, meta: { ...proof.meta!, err: { InstructionError: [0, 'InvalidArgument'] } } },
        expected
      )
    ).toThrow();
    expect(() => proveLaunchCreation({ ...proof, blockTime: undefined }, expected)).toThrow();
    expect(() =>
      proveLaunchCreation({ ...proof, blockTime: 2_000 }, { ...expected, vaultProgram: undefined })
    ).toThrow('outside');
  });
  it('recovers the exact atomic launch despite chain clock lag or expired confirmation time', () => {
    const { proof, expected } = fixture();
    expect(proveLaunchCreation({ ...proof, blockTime: 900 }, expected).creator).toBe(
      expected.deployer
    );
    expect(proveLaunchCreation({ ...proof, blockTime: 2_000 }, expected).creator).toBe(
      expected.deployer
    );
    expect(() =>
      proveLaunchCreation({ ...proof, blockTime: 2_000 }, { ...expected, mode: 'creator' })
    ).toThrow('registration');
  });
  it('rejects creations before finalized preparation and zero/missing slot intents', () => {
    const { proof, expected } = fixture();
    expect(() => proveLaunchCreation({ ...proof, slot: 98 }, expected)).toThrow('preparation slot');
    expect(() => proveLaunchCreation(proof, { ...expected, preparedSlot: '0' })).toThrow(
      'preparation slot'
    );
    expect(() => proveLaunchCreation(proof, { ...expected, preparedSlot: undefined })).toThrow(
      'preparation slot'
    );
    expect(proveLaunchCreation({ ...proof, slot: 99 }, expected).creator).toBe(expected.deployer);
  });
});
