import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { claimAddress, epochAddress, vaultAddresses } from '@/lib/vault/client';
import discriminators from '@/lib/vault/discriminators.json';
import type { FinancialJob } from './financialStore';
import { messageDigest, validateSignedTransaction, uninitializedSystemPda } from './chainEvidence';
import { rewardLeaf, verifyRewardProof } from './rewardMerkle';

const proofs = new WeakSet<object>();
export type CommunityClaimRenewal = {
  jobId: string;
  networkGenesis: string;
  mint: string;
  program: string;
  oldSignature: string;
  oldDigest: string;
  oldLastValidHeight: string;
  finalizedHeight: number;
  finalizedSlot: number;
  epochRoot: string;
  transactionBase64: string;
  messageDigest: string;
  lastValidBlockHeight: number;
};
export function assertCommunityClaimRenewal(proof: CommunityClaimRenewal) {
  if (!proofs.has(proof))
    throw new Error(
      'Community renewal requires positive finalized expiry and unclaimed funded custody proof'
    );
}

/** A slow wallet may re-sign only the identical expired Community entitlement; the original signature remains archived. */
export async function verifyExpiredCommunityClaim(
  rpc: Connection,
  job: FinancialJob,
  programId: string
): Promise<CommunityClaimRenewal> {
  if (
    job.kind !== 'community_claim' ||
    !job.signature ||
    !job.recipient ||
    job.epoch === null ||
    !['signed', 'submitted', 'manual_review'].includes(job.status)
  )
    throw new Error('Only a signed unsettled Community claim can renew');
  if ((await rpc.getGenesisHash()) !== job.network_genesis)
    throw new Error('Community renewal network mismatch');
  const signed = validateSignedTransaction(job.transaction_base64, job.message_digest);
  if (signed.signature !== job.signature)
    throw new Error('Claim signature does not match its exact stored message');
  const tx = VersionedTransaction.deserialize(signed.bytes),
    wallet = new PublicKey(job.recipient),
    program = new PublicKey(programId);
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
    throw new Error('The signed Community transaction has not definitively expired');
  const { coin } = vaultAddresses(program, new PublicKey(job.mint)),
    epoch = epochAddress(program, coin, BigInt(job.epoch)),
    marker = claimAddress(program, epoch, wallet);
  const snapshot = await rpc.getMultipleAccountsInfoAndContext([coin, epoch, marker], {
    commitment: 'finalized',
    minContextSlot: slot,
  });
  const [coinInfo, epochInfo, markerInfo] = snapshot.value,
    c = coinInfo?.data,
    e = epochInfo?.data;
  if (
    snapshot.context.slot < slot ||
    !coinInfo?.owner.equals(program) ||
    !c ||
    c.length !== 347 ||
    c.subarray(0, 8).toString() !== 'RCOIN001' ||
    c[8] !== 1 ||
    c[10] !== 1 ||
    !c.subarray(11, 43).equals(new PublicKey(job.mint).toBuffer()) ||
    !epochInfo?.owner.equals(program) ||
    !e ||
    e.length !== 138 ||
    e.subarray(0, 8).toString() !== 'REPOCH01' ||
    e[8] !== 1 ||
    !e.subarray(10, 42).equals(coin.toBuffer()) ||
    e.readBigUInt64LE(42) !== BigInt(job.epoch) ||
    e.readBigUInt64LE(130) < BigInt(job.lamports)
  )
    throw new Error('Canonical funded Community custody is missing or insufficient');
  if (!uninitializedSystemPda(markerInfo ?? null))
    throw new Error('Community claim marker exists; reconcile its finalized payment instead');
  const payload = Buffer.from(job.expectations.dataBase64, 'base64');
  if (
    payload.length < 26 ||
    !payload.subarray(0, 8).equals(Buffer.from(discriminators.claim_community)) ||
    payload.readBigUInt64LE(8) !== BigInt(job.epoch) ||
    payload.readBigUInt64LE(16) !== BigInt(job.lamports) ||
    payload.readUInt16LE(24) > 32 ||
    payload.length !== 26 + 32 * payload.readUInt16LE(24) ||
    tx.message.staticAccountKeys[0]?.toBase58() !== wallet.toBase58()
  )
    throw new Error('Community message differs from the fixed wallet entitlement');
  const merkle = Array.from({ length: payload.readUInt16LE(24) }, (_, i) =>
      payload.subarray(26 + i * 32, 58 + i * 32).toString('hex')
    ),
    epochRoot = e.subarray(50, 82).toString('hex');
  if (
    !verifyRewardProof(
      rewardLeaf(program, coin, BigInt(job.epoch), wallet, BigInt(job.lamports)),
      merkle,
      epochRoot
    )
  )
    throw new Error('Stored Community proof does not belong to the actual funded epoch root');
  const latest = await rpc.getLatestBlockhash('finalized');
  if (!Number.isSafeInteger(latest.lastValidBlockHeight) || latest.lastValidBlockHeight <= height)
    throw new Error('Fresh claim blockhash unavailable');
  tx.message.recentBlockhash = latest.blockhash;
  tx.signatures = tx.signatures.map(() => new Uint8Array(64));
  const proof: CommunityClaimRenewal = {
    jobId: job.id,
    networkGenesis: job.network_genesis,
    mint: job.mint,
    program: programId,
    oldSignature: job.signature,
    oldDigest: job.message_digest,
    oldLastValidHeight: job.last_valid_block_height,
    finalizedHeight: height,
    finalizedSlot: slot,
    epochRoot,
    transactionBase64: Buffer.from(tx.serialize()).toString('base64'),
    messageDigest: messageDigest(tx.message.serialize()),
    lastValidBlockHeight: latest.lastValidBlockHeight,
  };
  proofs.add(proof);
  return Object.freeze(proof);
}
