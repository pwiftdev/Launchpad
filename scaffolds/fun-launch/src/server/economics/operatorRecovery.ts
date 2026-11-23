import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { epochAddress, fundingAddress, vaultAddresses } from '@/lib/vault/client';
import type { OperatorPlan } from './operatorStore';
import { messageDigest, uninitializedSystemPda } from './chainEvidence';

const verified = new WeakSet<object>();
export type OperatorRefresh = {
  id: string;
  networkGenesis: string;
  oldDigest: string;
  oldLastValidHeight: string;
  finalizedHeight: number;
  finalizedSlot: number;
  transactionBase64: string;
  messageDigest: string;
  lastValidBlockHeight: number;
};
export function assertOperatorRefresh(proof: OperatorRefresh): void {
  if (!verified.has(proof))
    throw new Error('Operator refresh requires independently verified unsigned expiry');
}

/** Refresh only unsigned plans. Signed uncertainty must retain its original message and signature. */
export async function verifyOperatorRefresh(
  rpc: Connection,
  plan: OperatorPlan,
  programId: string
): Promise<OperatorRefresh> {
  if (plan.status !== 'prepared' || plan.signature)
    throw new Error('Only an unsigned prepared operator plan can refresh');
  if ((await rpc.getGenesisHash()) !== plan.network_genesis)
    throw new Error('Operator refresh network mismatch');
  const tx = VersionedTransaction.deserialize(Buffer.from(plan.transaction_base64, 'base64'));
  if (
    tx.signatures.some((signature) => signature.some((value) => value !== 0)) ||
    messageDigest(tx.message.serialize()) !== plan.message_digest
  )
    throw new Error('Operator plan is signed or altered');
  const [height, a, b, slot] = await Promise.all([
    rpc.getBlockHeight('finalized'),
    rpc.isBlockhashValid(tx.message.recentBlockhash, { commitment: 'finalized' }),
    rpc.isBlockhashValid(tx.message.recentBlockhash, { commitment: 'confirmed' }),
    rpc.getSlot('finalized'),
  ]);
  if (
    !Number.isSafeInteger(height) ||
    BigInt(height) <= BigInt(plan.last_valid_block_height) ||
    a.value ||
    b.value
  )
    throw new Error('The operator message has not definitively expired');
  const program = new PublicKey(programId),
    { coin } = vaultAddresses(program, new PublicKey(plan.mint));
  let marker: PublicKey | null = null;
  if (plan.kind === 'funding') {
    if (
      typeof plan.metadata.commitment !== 'string' ||
      !/^[a-f0-9]{64}$/.test(plan.metadata.commitment)
    )
      throw new Error('Funding commitment missing');
    marker = fundingAddress(program, coin, Buffer.from(plan.metadata.commitment, 'hex'));
  } else if (plan.kind === 'epoch') {
    const epoch = Number(plan.metadata.epoch);
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('Epoch missing');
    marker = epochAddress(program, coin, BigInt(epoch));
  }
  if (marker) {
    const account = await rpc.getAccountInfoAndContext(marker, {
      commitment: 'finalized',
      minContextSlot: slot,
    });
    if (account.context.slot < slot || !uninitializedSystemPda(account.value))
      throw new Error('Operator effect may already exist; reconcile its finalized receipt');
  }
  const fresh = await rpc.getLatestBlockhash('finalized');
  if (!Number.isSafeInteger(fresh.lastValidBlockHeight) || fresh.lastValidBlockHeight <= height)
    throw new Error('Fresh blockhash unavailable');
  // No instruction/account/fee-payer mutation: only the recent blockhash is replaced.
  tx.message.recentBlockhash = fresh.blockhash;
  const proof: OperatorRefresh = {
    id: plan.id,
    networkGenesis: plan.network_genesis,
    oldDigest: plan.message_digest,
    oldLastValidHeight: plan.last_valid_block_height,
    finalizedHeight: height,
    finalizedSlot: slot,
    transactionBase64: Buffer.from(tx.serialize()).toString('base64'),
    messageDigest: messageDigest(tx.message.serialize()),
    lastValidBlockHeight: fresh.lastValidBlockHeight,
  };
  verified.add(proof);
  return proof;
}
