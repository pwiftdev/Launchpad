import { BorshCoder, type Idl } from '@coral-xyz/anchor';
import { PublicKey, type VersionedTransactionResponse } from '@solana/web3.js';
import {
  DynamicBondingCurveIdl,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { registerCoinInstruction } from '@/lib/vault/client';

import { isWalletPolicy, type LaunchPolicyVersion } from '@/lib/launchModes';

const coder = new BorshCoder(DynamicBondingCurveIdl as unknown as Idl);
const initialize = DynamicBondingCurveIdl.instructions.find(
  (ix) => ix.name === 'initialize_virtual_pool_with_spl_token'
);

/** Proves the original creator from the finalized creation instruction, not current mutable creator state. */
export function proveLaunchCreation(
  tx: VersionedTransactionResponse,
  expected: {
    mint: string;
    config: string;
    pool: string;
    deployer: string;
    intentCreatedAt: number;
    intentExpiresAt: number;
    preparedSlot?: string;
    vaultProgram?: PublicKey;
    mode?: import('@/lib/launchModes').LaunchMode;
    policyVersion?: LaunchPolicyVersion;
  }
) {
  if (!tx.meta || tx.meta.err || typeof tx.blockTime !== 'number' || !initialize)
    throw new Error('A successful timestamped creation transaction is required');
  const createdMs = tx.blockTime * 1000;
  if (
    (expected.vaultProgram || isWalletPolicy(expected.policyVersion ?? '')) &&
    (!expected.preparedSlot ||
      !/^\d+$/.test(expected.preparedSlot) ||
      BigInt(expected.preparedSlot) <= 0n ||
      !Number.isSafeInteger(tx.slot) ||
      BigInt(tx.slot) < BigInt(expected.preparedSlot))
  )
    throw new Error('Creation predates the finalized launch preparation slot');
  // wallet-v1 binds the original creator/mint/config to an immutable wallet-signed
  // SQL intent and finalized preparation slot; mode never comes from metadata.
  // Legacy native launches prove mode atomically. Confirmation time is not expiry.
  if (
    !expected.vaultProgram &&
    !isWalletPolicy(expected.policyVersion ?? '') &&
    (createdMs < expected.intentCreatedAt - 10_000 || createdMs > expected.intentExpiresAt)
  )
    throw new Error('Creation occurred outside the signed launch intent');
  const message = tx.transaction.message;
  if (
    isWalletPolicy(expected.policyVersion ?? '') &&
    (!expected.mode || expected.vaultProgram)
  )
    throw new Error('Wallet policy requires the immutable signed mode without native registration');
  const keys = message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
  for (const instruction of message.compiledInstructions) {
    if (!keys.get(instruction.programIdIndex)?.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) continue;
    const decoded = coder.instruction.decode(Buffer.from(instruction.data));
    if (decoded?.name !== initialize.name) continue;
    const account = (name: string) => {
      const index = initialize.accounts.findIndex((a) => a.name === name);
      const keyIndex = instruction.accountKeyIndexes[index];
      if (index < 0 || keyIndex === undefined) throw new Error('Missing creation account');
      const key = keys.get(keyIndex);
      if (!key) throw new Error('Missing creation key');
      return { key, index: keyIndex };
    };
    if (
      account('base_mint').key.toBase58() !== expected.mint ||
      account('config').key.toBase58() !== expected.config ||
      account('pool').key.toBase58() !== expected.pool ||
      account('creator').key.toBase58() !== expected.deployer
    )
      continue;
    if (
      !message.isAccountSigner(account('creator').index) ||
      !message.isAccountSigner(account('base_mint').index)
    )
      throw new Error('Creator and mint must sign the creation transaction');
    if (expected.vaultProgram) {
      if (expected.mode !== 'creator' && expected.mode !== 'community')
        throw new Error('A legacy signed launch mode is required for native custody');
      const register = registerCoinInstruction({
        programId: expected.vaultProgram,
        mint: new PublicKey(expected.mint),
        pool: new PublicKey(expected.pool),
        config: new PublicKey(expected.config),
        creator: new PublicKey(expected.deployer),
        mode: expected.mode,
      });
      const registration = message.compiledInstructions.find(
        (ix) =>
          keys.get(ix.programIdIndex)?.equals(register.programId) &&
          Buffer.from(ix.data).equals(register.data) &&
          ix.accountKeyIndexes.length === register.keys.length &&
          register.keys.every((key, index) => {
            const at = ix.accountKeyIndexes[index];
            return (
              at !== undefined &&
              keys.get(at)?.equals(key.pubkey) &&
              (!key.isSigner || message.isAccountSigner(at))
            );
          })
      );
      if (!registration)
        throw new Error('Atomic custody registration is missing or differs from the signed mode');
    }
    return {
      slot: tx.slot,
      signature: tx.transaction.signatures[0],
      creator: new PublicKey(expected.deployer).toBase58(),
    };
  }
  throw new Error('Expected pool creation instruction was not found');
}
