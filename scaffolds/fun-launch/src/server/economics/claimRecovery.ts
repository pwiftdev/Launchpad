import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { claimAddress, epochAddress, vaultAddresses } from '@/lib/vault/client';
import type { FinancialJob } from './financialStore';
import { uninitializedSystemPda } from './chainEvidence';

const verified = new WeakSet<object>();
const buybackProofs = new WeakSet<object>();
export type UnsignedBuybackExpiry = {
  networkGenesis: string;
  mint: string;
  program: string;
  jobId: string;
  messageDigest: string;
  lastValidBlockHeight: string;
  finalizedHeight: number;
  finalizedSlot: number;
  buybackBudget: bigint;
  nonce: bigint;
};
export function assertUnsignedBuybackExpiry(proof: UnsignedBuybackExpiry): void {
  if (!buybackProofs.has(proof))
    throw new Error(
      'Buyback recovery requires independently verified expiry and unchanged custody'
    );
}

/** An expired unsigned quote can release its reservation only while its native nonce and budget remain unchanged. */
export async function verifyUnsignedBuybackExpiry(
  rpc: Connection,
  job: FinancialJob,
  programId: string
): Promise<UnsignedBuybackExpiry> {
  if (
    job.signature ||
    job.status !== 'prepared' ||
    job.kind !== 'buyback' ||
    job.expectations.effect !== 'buyback_burn'
  )
    throw new Error('Only an unsigned prepared atomic buyback can expire');
  if ((await rpc.getGenesisHash()) !== job.network_genesis)
    throw new Error('Buyback recovery network mismatch');
  const tx = VersionedTransaction.deserialize(Buffer.from(job.transaction_base64, 'base64'));
  const [height, a, b, slot] = await Promise.all([
    rpc.getBlockHeight('finalized'),
    rpc.isBlockhashValid(tx.message.recentBlockhash, { commitment: 'finalized' }),
    rpc.isBlockhashValid(tx.message.recentBlockhash, { commitment: 'confirmed' }),
    rpc.getSlot('finalized'),
  ]);
  if (
    !Number.isSafeInteger(height) ||
    BigInt(height) <= BigInt(job.last_valid_block_height) ||
    a.value ||
    b.value
  )
    throw new Error('The prepared buyback has not definitively expired');
  const program = new PublicKey(programId),
    { coin } = vaultAddresses(program, new PublicKey(job.mint));
  const account = await rpc.getAccountInfoAndContext(coin, {
      commitment: 'finalized',
      minContextSlot: slot,
    }),
    data = account.value?.data;
  const instruction = Buffer.from(job.expectations.dataBase64, 'base64');
  if (
    account.context.slot < slot ||
    !account.value?.owner.equals(program) ||
    !data ||
    data.length !== 347 ||
    data[8] !== 1 ||
    data.subarray(0, 8).toString() !== 'RCOIN001' ||
    !data.subarray(11, 43).equals(new PublicKey(job.mint).toBuffer()) ||
    job.expectations.vault !== coin.toBase58() ||
    instruction.length < 24 ||
    data.readBigUInt64LE(179) !== instruction.readBigUInt64LE(8)
  )
    throw new Error('Buyback custody or execution nonce changed; reconcile finalized receipts');
  const proof: UnsignedBuybackExpiry = {
    networkGenesis: job.network_genesis,
    mint: job.mint,
    program: programId,
    jobId: job.id,
    messageDigest: job.message_digest,
    lastValidBlockHeight: job.last_valid_block_height,
    finalizedHeight: height,
    finalizedSlot: slot,
    buybackBudget: data.readBigUInt64LE(147),
    nonce: data.readBigUInt64LE(179),
  };
  buybackProofs.add(proof);
  return proof;
}
export type UnsignedClaimExpiry = {
  networkGenesis: string;
  mint: string;
  program: string;
  jobId: string;
  messageDigest: string;
  lastValidBlockHeight: string;
  finalizedHeight: number;
  finalizedSlot: number;
  creatorBudget: bigint | null;
  platformBudget: bigint | null;
};
export function assertUnsignedClaimExpiry(proof: UnsignedClaimExpiry): void {
  if (!verified.has(proof))
    throw new Error('Claim renewal requires independently verified expiry and unchanged custody');
}

/** An absent signature status alone is never evidence of failure or permission to spend again. */
export async function verifyUnsignedClaimExpiry(
  rpc: Connection,
  job: FinancialJob,
  programId: string
): Promise<UnsignedClaimExpiry> {
  if (
    job.signature ||
    job.status !== 'prepared' ||
    !['creator_claim', 'community_claim', 'platform_claim'].includes(job.kind)
  )
    throw new Error('Only an unsigned prepared claim can use the expiry recovery path');
  if ((await rpc.getGenesisHash()) !== job.network_genesis)
    throw new Error('Claim recovery network mismatch');
  const transaction = VersionedTransaction.deserialize(
    Buffer.from(job.transaction_base64, 'base64')
  );
  const [height, validFinalized, validConfirmed, slot] = await Promise.all([
    rpc.getBlockHeight('finalized'),
    rpc.isBlockhashValid(transaction.message.recentBlockhash, { commitment: 'finalized' }),
    rpc.isBlockhashValid(transaction.message.recentBlockhash, { commitment: 'confirmed' }),
    rpc.getSlot('finalized'),
  ]);
  if (
    !Number.isSafeInteger(height) ||
    BigInt(height) <= BigInt(job.last_valid_block_height) ||
    validFinalized.value ||
    validConfirmed.value
  )
    throw new Error('The prepared transaction has not definitively expired');
  const program = new PublicKey(programId),
    { coin, settings } = vaultAddresses(program, new PublicKey(job.mint));
  const account = await rpc.getAccountInfoAndContext(coin, {
    commitment: 'finalized',
    minContextSlot: slot,
  });
  const data = account.value?.data;
  if (
    account.context.slot < slot ||
    !account.value?.owner.equals(program) ||
    !data ||
    data.length !== 347 ||
    data.subarray(0, 8).toString() !== 'RCOIN001' ||
    data[8] !== 1 ||
    !data.subarray(11, 43).equals(new PublicKey(job.mint).toBuffer())
  )
    throw new Error('Canonical coin custody proof is missing');
  let creatorBudget: bigint | null = null;
  let platformBudget: bigint | null = null;
  if (job.kind === 'creator_claim') {
    if (
      data[10] !== 0 ||
      !job.recipient ||
      !data.subarray(107, 139).equals(new PublicKey(job.recipient).toBuffer())
    )
      throw new Error('Claim recovery does not belong to the immutable creator');
    creatorBudget = data.readBigUInt64LE(155);
  } else if (job.kind === 'platform_claim') {
    const actual = await rpc.getAccountInfoAndContext(settings, {
        commitment: 'finalized',
        minContextSlot: slot,
      }),
      state = actual.value?.data;
    if (
      actual.context.slot < slot ||
      !actual.value?.owner.equals(program) ||
      !state ||
      state.length !== 107 ||
      state.subarray(0, 8).toString() !== 'RSET0001' ||
      state[8] !== 1 ||
      !job.recipient ||
      !state.subarray(75, 107).equals(new PublicKey(job.recipient).toBuffer())
    )
      throw new Error('Treasury recovery does not belong to actual reviewed settings');
    platformBudget = data.readBigUInt64LE(171);
  } else {
    if (data[10] !== 1 || job.epoch === null || !job.recipient)
      throw new Error('Invalid Community recovery');
    const epoch = epochAddress(program, coin, BigInt(job.epoch)),
      marker = claimAddress(program, epoch, new PublicKey(job.recipient));
    const markerState = await rpc.getAccountInfoAndContext(marker, {
      commitment: 'finalized',
      minContextSlot: slot,
    });
    if (markerState.context.slot < slot || !uninitializedSystemPda(markerState.value))
      throw new Error('Claim may already be paid; reconcile its finalized receipt');
  }
  const proof: UnsignedClaimExpiry = {
    networkGenesis: job.network_genesis,
    mint: job.mint,
    program: programId,
    jobId: job.id,
    messageDigest: job.message_digest,
    lastValidBlockHeight: job.last_valid_block_height,
    finalizedHeight: height,
    finalizedSlot: slot,
    creatorBudget,
    platformBudget,
  };
  verified.add(proof);
  return proof;
}
