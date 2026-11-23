import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { allocateCollectedFeesInstruction, fundingAddress } from '@/lib/vault/client';
import {
  FinancialStore,
  encodeFundingPlan,
  realizedFundingCommitment,
  type EventId,
} from './financialStore';
import { verifyDammRealization, type VerifiedDammRealization } from './dammRealization';
import { MeteoraFinancialAdapter } from './meteoraAdapter';
import { messageDigest, validateSignedTransaction, uninitializedSystemPda } from './chainEvidence';
import type { OperatorPlan } from './operatorStore';
import { FinancialDammCheckpointStore } from './checkpointStore';

const proofs = new WeakSet<object>();
export type CollectedFundingRecovery = {
  id: string;
  networkGenesis: string;
  mint: string;
  oldSignature: string;
  oldDigest: string;
  oldLastValidHeight: string;
  commitment: string;
  oldCommitment: string;
  realization: VerifiedDammRealization;
  reuseCommitment: boolean;
  amount: bigint;
  unallocated: bigint;
  finalizedHeight: number;
  finalizedSlot: number;
  transactionBase64: string;
  messageDigest: string;
  lastValidBlockHeight: number;
  metadata: Record<string, unknown>;
};
export function assertCollectedFundingRecovery(proof: CollectedFundingRecovery) {
  if (!proofs.has(proof))
    throw new Error(
      'Collected funding recovery requires positive finalized custody and expiry proof'
    );
}

/** A reduced realized amount gets a NEW commitment/PDA only after positive expiry and absence of the old receipt. */
export async function verifyCollectedFundingRecovery(input: {
  rpc: Connection;
  store: FinancialStore;
  plan: OperatorPlan;
  program: PublicKey;
  operator: PublicKey;
}) {
  const { rpc, store, plan, program, operator } = input;
  if (
    plan.kind !== 'funding' ||
    plan.metadata.sourceKind !== 'damm_claim' ||
    !plan.signature ||
    !['signed', 'submitted', 'manual_review', 'failed'].includes(plan.status)
  )
    throw new Error('Only a signed DAMM funding attempt can use this narrow recovery');
  if ((await rpc.getGenesisHash()) !== plan.network_genesis)
    throw new Error('Funding recovery network mismatch');
  const signed = validateSignedTransaction(plan.transaction_base64, plan.message_digest);
  if (signed.signature !== plan.signature) throw new Error('Stored funding signature changed');
  const tx = VersionedTransaction.deserialize(signed.bytes);
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
    throw new Error('The signed funding transaction has not definitively expired');
  const events = plan.metadata.events as EventId[];
  if (!Array.isArray(events) || !events.length)
    throw new Error('Original funding event set missing');
  const funding = await store.previewFundingPlan(
    plan.network_genesis,
    plan.mint,
    events,
    'damm_claim'
  );
  if (funding.commitment !== plan.metadata.commitment)
    throw new Error('Funding event commitment changed');
  const state = await new MeteoraFinancialAdapter(
    rpc,
    store,
    program,
    operator,
    plan.network_genesis
  ).state(new PublicKey(plan.mint));
  if (state.slot < slot || state.unallocatedCollected <= 0n)
    throw new Error('Finalized collected fees cannot cover this exact event set');
  const address = fundingAddress(program, state.addresses.coin, funding.fundingId);
  const marker = await rpc.getAccountInfoAndContext(address, {
    commitment: 'finalized',
    minContextSlot: slot,
  });
  if (marker.context.slot < slot || !uninitializedSystemPda(marker.value))
    throw new Error('One-time funding receipt exists; reconcile it instead');
  const old = tx.message.compiledInstructions.filter((ix) =>
    tx.message.staticAccountKeys[ix.programIdIndex]?.equals(program)
  );
  if (
    old.length !== 1 ||
    !Buffer.from(old[0]!.data).equals(encodeFundingPlan(funding)) ||
    tx.message.staticAccountKeys[0]?.toBase58() !== operator.toBase58() ||
    old[0]!.accountKeyIndexes[2] === undefined ||
    !tx.message.staticAccountKeys[old[0]!.accountKeyIndexes[2]!]!.equals(state.addresses.coin)
  )
    throw new Error('Original signed claim differs from the exact canonical funding intent');
  const accounted = await store.dammAccountedTotals(plan.network_genesis, plan.mint, funding.pool);
  const realization = await verifyDammRealization({
    rpc,
    genesis: plan.network_genesis,
    mint: plan.mint,
    pool: funding.pool,
    rawExpected: funding.events.reduce((sum, event) => sum + event.net, 0n),
    eventCount: funding.events.length,
    eventIds: funding.events.map((event) => event.id),
    source: 'collected',
    collectedAvailable: state.unallocatedCollected,
    programId: program,
    ...accounted,
    checkpointStore: new FinancialDammCheckpointStore(),
  });
  if (realization.realizedNet <= 0n || realization.realizedNet > state.unallocatedCollected)
    throw new Error('Finalized collected fees cannot cover the independently realized amount');
  if (funding.realization && realization.realizedNet !== funding.lamports)
    throw new Error('Immutable realized prefix changed; reconcile the exact finalized event proof');
  const commitment = funding.realization
    ? funding.commitment
    : realizedFundingCommitment(
        funding.commitment,
        realization.realizedNet,
        realization.shortfall,
        realization.digest
      );
  const instruction = allocateCollectedFeesInstruction({
    programId: program,
    mint: new PublicKey(plan.mint),
    operator,
    fundingId: commitment,
    commitment,
    events: [{ phase: 1, net: realization.realizedNet }],
  });
  const latest = await rpc.getLatestBlockhash('finalized');
  const fresh = new Transaction({ feePayer: operator, recentBlockhash: latest.blockhash }).add(
    instruction
  );
  const proof: CollectedFundingRecovery = {
    id: plan.id,
    networkGenesis: plan.network_genesis,
    mint: plan.mint,
    oldSignature: plan.signature,
    oldDigest: plan.message_digest,
    oldLastValidHeight: plan.last_valid_block_height,
    commitment,
    oldCommitment: funding.commitment,
    realization,
    reuseCommitment: funding.realization !== undefined,
    amount: realization.realizedNet,
    unallocated: state.unallocatedCollected,
    finalizedHeight: height,
    finalizedSlot: slot,
    transactionBase64: fresh
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64'),
    messageDigest: messageDigest(fresh.serializeMessage()),
    lastValidBlockHeight: latest.lastValidBlockHeight,
    metadata: {
      events,
      sourceKind: 'collected_allocation',
      commitment,
      vault: state.addresses.coin.toBase58(),
      accounts: instruction.keys.map((key) => key.pubkey.toBase58()),
      dataBase64: instruction.data.toString('base64'),
      instructionIndex: 0,
    },
  };
  proofs.add(proof);
  return Object.freeze(proof);
}
