import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token';
import discriminators from './discriminators.json';

export type VaultLaunchMode = 'creator' | 'community';
export const VAULT_ABI_VERSION = 1;
const U64_MAX = (1n << 64n) - 1n;

export function u64(value: bigint): Buffer {
  if (value < 0n || value > U64_MAX) throw new Error('Amount outside u64 range');
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}
export function digest32(value: string | Uint8Array): Buffer {
  if (typeof value === 'string' && !/^[a-f0-9]{64}$/i.test(value))
    throw new Error('Expected SHA-256 digest');
  const out = typeof value === 'string' ? Buffer.from(value, 'hex') : Buffer.from(value);
  if (out.length !== 32) throw new Error('Expected 32 bytes');
  return out;
}
export function vaultAddresses(programId: PublicKey, mint: PublicKey) {
  const [settings] = PublicKey.findProgramAddressSync([Buffer.from('settings')], programId);
  const [feeAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('fee-authority')],
    programId
  );
  const [coin] = PublicKey.findProgramAddressSync(
    [Buffer.from('coin'), mint.toBuffer()],
    programId
  );
  return {
    settings,
    feeAuthority,
    coin,
    quoteAccount: getAssociatedTokenAddressSync(NATIVE_MINT, coin, true),
    tokenAccount: getAssociatedTokenAddressSync(mint, coin, true),
  };
}
export const configApprovalAddress = (programId: PublicKey, config: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from('config'), config.toBuffer()], programId)[0];
export const fundingAddress = (programId: PublicKey, coin: PublicKey, id: string | Uint8Array) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from('funding'), coin.toBuffer(), digest32(id)],
    programId
  )[0];
export const epochAddress = (programId: PublicKey, coin: PublicKey, epoch: bigint) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from('epoch'), coin.toBuffer(), u64(epoch)],
    programId
  )[0];
export const claimAddress = (programId: PublicKey, epoch: PublicKey, wallet: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from('claim'), epoch.toBuffer(), wallet.toBuffer()],
    programId
  )[0];

const meta = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({
  pubkey,
  isWritable,
  isSigner,
});
export function registerCoinInstruction({
  programId,
  mint,
  pool,
  config,
  creator,
  mode,
}: {
  programId: PublicKey;
  mint: PublicKey;
  pool: PublicKey;
  config: PublicKey;
  creator: PublicKey;
  mode: VaultLaunchMode;
}): TransactionInstruction {
  if (mode !== 'creator' && mode !== 'community') throw new Error('Invalid launch mode');
  const { settings, coin } = vaultAddresses(programId, mint);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(creator, true, true),
      meta(settings),
      meta(coin, true),
      meta(mint),
      meta(pool),
      meta(config),
      meta(configApprovalAddress(programId, config)),
      meta(SystemProgram.programId),
    ],
    data: Buffer.concat([
      Buffer.from(discriminators.register_coin),
      Buffer.from([mode === 'creator' ? 0 : 1]),
    ]),
  });
}

export function collectFeesInstruction({
  programId,
  mint,
  operator,
  dexProgram,
  claimAccounts,
  fundingId,
  commitment,
  events,
  migrated = false,
}: {
  programId: PublicKey;
  mint: PublicKey;
  operator: PublicKey;
  dexProgram: PublicKey;
  claimAccounts: AccountMeta[];
  fundingId: string | Uint8Array;
  commitment: string | Uint8Array;
  events: readonly { phase: 0 | 1; net: bigint }[];
  migrated?: boolean;
}): TransactionInstruction {
  if (!events.length || events.length > 32)
    throw new Error('Funding batch must contain 1–32 events');
  const count = Buffer.alloc(2);
  count.writeUInt16LE(events.length);
  const parts = events.map((event) => {
    if ((event.phase !== 0 && event.phase !== 1) || event.net <= 0n)
      throw new Error('Invalid fee event');
    return Buffer.concat([Buffer.from([event.phase]), u64(event.net)]);
  });
  const { settings, coin, quoteAccount, feeAuthority } = vaultAddresses(programId, mint);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(operator, true, true),
      meta(settings),
      meta(coin, true),
      meta(fundingAddress(programId, coin, fundingId), true),
      meta(quoteAccount, true),
      meta(feeAuthority),
      meta(TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
      meta(dexProgram),
      ...claimAccounts.map((account) => {
        if (
          account.isSigner &&
          !account.pubkey.equals(feeAuthority) &&
          !account.pubkey.equals(coin) &&
          !account.pubkey.equals(operator)
        )
          throw new Error('Unexpected external claim signer');
        return { ...account, isSigner: account.pubkey.equals(operator) && account.isSigner };
      }),
    ],
    data: Buffer.concat([
      Buffer.from(discriminators[migrated ? 'collect_damm_fees' : 'collect_fees']),
      digest32(fundingId),
      digest32(commitment),
      count,
      ...parts,
    ]),
  });
}

export function claimCreatorInstruction(
  programId: PublicKey,
  mint: PublicKey,
  wallet: PublicKey,
  amount: bigint
) {
  if (amount <= 0n) throw new Error('Claim amount must be positive');
  const { coin } = vaultAddresses(programId, mint);
  return new TransactionInstruction({
    programId,
    keys: [meta(wallet, true, true), meta(coin, true)],
    data: Buffer.concat([Buffer.from(discriminators.claim_creator), u64(amount)]),
  });
}
export function claimCommunityInstruction({
  programId,
  mint,
  wallet,
  epoch,
  amount,
  proof,
}: {
  programId: PublicKey;
  mint: PublicKey;
  wallet: PublicKey;
  epoch: bigint;
  amount: bigint;
  proof: readonly (string | Uint8Array)[];
}) {
  if (amount <= 0n || proof.length > 32) throw new Error('Invalid claim');
  const { coin } = vaultAddresses(programId, mint),
    epochKey = epochAddress(programId, coin, epoch);
  const count = Buffer.alloc(2);
  count.writeUInt16LE(proof.length);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(wallet, true, true),
      meta(coin),
      meta(epochKey, true),
      meta(claimAddress(programId, epochKey, wallet), true),
      meta(SystemProgram.programId),
    ],
    data: Buffer.concat([
      Buffer.from(discriminators.claim_community),
      u64(epoch),
      u64(amount),
      count,
      ...proof.map(digest32),
    ]),
  });
}

export function initializeVaultInstruction({
  programId,
  governor,
  operator,
  treasury,
  paused = true,
}: {
  programId: PublicKey;
  governor: PublicKey;
  operator: PublicKey;
  treasury: PublicKey;
  paused?: boolean;
}) {
  const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
  const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], loader);
  const [settings] = PublicKey.findProgramAddressSync([Buffer.from('settings')], programId);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(governor, true, true),
      meta(settings, true),
      meta(programId),
      meta(programData),
      meta(SystemProgram.programId),
    ],
    data: Buffer.concat([
      Buffer.from(discriminators.initialize),
      operator.toBuffer(),
      treasury.toBuffer(),
      Buffer.from([paused ? 1 : 0]),
    ]),
  });
}
export function approveConfigInstruction(
  programId: PublicKey,
  governor: PublicKey,
  config: PublicKey
) {
  const [settings] = PublicKey.findProgramAddressSync([Buffer.from('settings')], programId);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(governor, true, true),
      meta(settings),
      meta(configApprovalAddress(programId, config), true),
      meta(config),
      meta(SystemProgram.programId),
    ],
    data: Buffer.from(discriminators.approve_config),
  });
}
export function setPausedInstruction(programId: PublicKey, governor: PublicKey, paused: boolean) {
  const [settings] = PublicKey.findProgramAddressSync([Buffer.from('settings')], programId);
  return new TransactionInstruction({
    programId,
    keys: [meta(governor, false, true), meta(settings, true)],
    data: Buffer.concat([Buffer.from(discriminators.set_paused), Buffer.from([paused ? 1 : 0])]),
  });
}
export function createEpochInstruction({
  programId,
  mint,
  operator,
  epoch,
  root,
  snapshotSlot,
  snapshotDigest,
  total,
}: {
  programId: PublicKey;
  mint: PublicKey;
  operator: PublicKey;
  epoch: bigint;
  root: string | Uint8Array;
  snapshotSlot: bigint;
  snapshotDigest: string | Uint8Array;
  total: bigint;
}) {
  if (total <= 0n) throw new Error('Epoch funding must be positive');
  const { settings, coin } = vaultAddresses(programId, mint);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(operator, true, true),
      meta(settings),
      meta(coin, true),
      meta(epochAddress(programId, coin, epoch), true),
      meta(SystemProgram.programId),
    ],
    data: Buffer.concat([
      Buffer.from(discriminators.create_epoch),
      u64(epoch),
      digest32(root),
      u64(snapshotSlot),
      digest32(snapshotDigest),
      u64(total),
    ]),
  });
}
export function executeBuybackBurnInstruction({
  programId,
  mint,
  operator,
  dexProgram,
  swapAccounts,
  nonce,
  amount,
  minOut,
  deadline,
  route,
  swapData,
}: {
  programId: PublicKey;
  mint: PublicKey;
  operator: PublicKey;
  dexProgram: PublicKey;
  swapAccounts: AccountMeta[];
  nonce: bigint;
  amount: bigint;
  minOut: bigint;
  deadline: bigint;
  route: 'dbc' | 'damm-v2';
  swapData: Uint8Array;
}) {
  if (amount <= 0n || minOut <= 0n || swapData.length > 512)
    throw new Error('Invalid buyback bounds');
  const { settings, coin, quoteAccount, tokenAccount } = vaultAddresses(programId, mint);
  const expiry = Buffer.alloc(8);
  expiry.writeBigInt64LE(deadline);
  const length = Buffer.alloc(2);
  length.writeUInt16LE(swapData.length);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(operator, true, true),
      meta(settings),
      meta(coin, true),
      meta(quoteAccount, true),
      meta(tokenAccount, true),
      meta(mint, true),
      meta(TOKEN_PROGRAM_ID),
      meta(dexProgram),
      ...swapAccounts.map((account) => {
        if (account.isSigner && !account.pubkey.equals(coin))
          throw new Error('Unexpected buyback signer');
        return { ...account, isSigner: false };
      }),
    ],
    data: Buffer.concat([
      Buffer.from(discriminators.execute_buyback_burn),
      u64(nonce),
      u64(amount),
      u64(minOut),
      expiry,
      Buffer.from([route === 'dbc' ? 0 : 1]),
      length,
      Buffer.from(swapData),
    ]),
  });
}
export function claimPlatformInstruction(
  programId: PublicKey,
  mint: PublicKey,
  treasury: PublicKey,
  amount: bigint
) {
  if (amount <= 0n) throw new Error('Claim amount must be positive');
  const { settings, coin } = vaultAddresses(programId, mint);
  return new TransactionInstruction({
    programId,
    keys: [meta(treasury, true, true), meta(coin, true), meta(settings)],
    data: Buffer.concat([Buffer.from(discriminators.claim_platform), u64(amount)]),
  });
}
export function allocateCollectedFeesInstruction({
  programId,
  mint,
  operator,
  fundingId,
  commitment,
  events,
}: {
  programId: PublicKey;
  mint: PublicKey;
  operator: PublicKey;
  fundingId: string | Uint8Array;
  commitment: string | Uint8Array;
  events: readonly { phase: 0 | 1; net: bigint }[];
}) {
  if (!events.length || events.length > 32) throw new Error('Invalid funding phases');
  const { settings, coin } = vaultAddresses(programId, mint),
    count = Buffer.alloc(2);
  count.writeUInt16LE(events.length);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(operator, true, true),
      meta(settings),
      meta(coin, true),
      meta(fundingAddress(programId, coin, fundingId), true),
      meta(SystemProgram.programId),
    ],
    data: Buffer.concat([
      Buffer.from(discriminators.allocate_collected_fees),
      digest32(fundingId),
      digest32(commitment),
      count,
      ...events.map((event) => {
        if ((event.phase !== 0 && event.phase !== 1) || event.net <= 0n)
          throw new Error('Invalid fee phase');
        return Buffer.concat([Buffer.from([event.phase]), u64(event.net)]);
      }),
    ]),
  });
}
export function bindMigrationInstruction({
  programId,
  mint,
  operator,
  dbcPool,
  config,
  pool,
  position,
  nftAccount,
}: {
  programId: PublicKey;
  mint: PublicKey;
  operator: PublicKey;
  dbcPool: PublicKey;
  config: PublicKey;
  pool: PublicKey;
  position: PublicKey;
  nftAccount: PublicKey;
}) {
  const { settings, coin } = vaultAddresses(programId, mint);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(operator, false, true),
      meta(settings),
      meta(coin, true),
      meta(dbcPool),
      meta(config),
      meta(pool),
      meta(position),
      meta(nftAccount),
    ],
    data: Buffer.from(discriminators.bind_migration),
  });
}
