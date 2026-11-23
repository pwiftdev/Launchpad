import { randomUUID } from 'node:crypto';
import { VersionedTransaction } from '@solana/web3.js';
import { database } from '../database';
import {
  messageDigest,
  validateSignedTransaction,
  assertFinalizedEvidence,
  type FinalizedEvidence,
} from './chainEvidence';
import { assertOperatorRefresh, type OperatorRefresh } from './operatorRecovery';
import { assertFinalizedFailure, type FinalizedFailure } from './chainEvidence';
import { assertCollectedFundingRecovery, type CollectedFundingRecovery } from './fundingRecovery';
import { assertDammRealization } from './dammRealization';
import { recordFinalizedDammWindows } from './realizationFacts';

export type OperatorPlan = {
  id: string;
  network_genesis: string;
  mint: string;
  kind: 'setup' | 'funding' | 'epoch';
  intent_key: string;
  transaction_base64: string;
  message_digest: string;
  last_valid_block_height: string;
  metadata: Record<string, unknown>;
  status: 'prepared' | 'signed' | 'submitted' | 'manual_review' | 'finalized' | 'failed';
  signature: string | null;
  finalized_slot: string | null;
};

export async function operatorPlan(id: string): Promise<OperatorPlan | null> {
  return (
    (
      await database().query<OperatorPlan>('SELECT * FROM financial_operator_plans WHERE id=$1', [
        id,
      ])
    ).rows[0] ?? null
  );
}

export async function recoverCollectedFunding(
  proof: CollectedFundingRecovery
): Promise<OperatorPlan> {
  assertCollectedFundingRecovery(proof);
  assertDammRealization(proof.realization);
  if (proof.realization.source !== 'collected')
    throw new Error('Audit or uncollected realization cannot change a funding intent');
  const client = await database().connect();
  try {
    await client.query('BEGIN');
    const old = (
      await client.query<OperatorPlan>(
        'SELECT * FROM financial_operator_plans WHERE id=$1 FOR UPDATE',
        [proof.id]
      )
    ).rows[0];
    if (
      !old ||
      old.network_genesis !== proof.networkGenesis ||
      old.mint !== proof.mint ||
      old.signature !== proof.oldSignature ||
      old.message_digest !== proof.oldDigest ||
      old.last_valid_block_height !== proof.oldLastValidHeight ||
      old.kind !== 'funding' ||
      old.metadata.sourceKind !== 'damm_claim' ||
      old.metadata.commitment !== proof.oldCommitment ||
      !['signed', 'submitted', 'manual_review', 'failed'].includes(old.status)
    )
      throw new Error('Signed funding state changed during recovery');
    const reserve = (
      await client.query<{ lamports: string }>(
        `SELECT lamports FROM financial_collected_reserves
      WHERE network_genesis=$1 AND mint=$2 FOR UPDATE`,
        [proof.networkGenesis, proof.mint]
      )
    ).rows[0];
    if (
      !reserve ||
      BigInt(reserve.lamports) < proof.amount ||
      BigInt(reserve.lamports) !== proof.unallocated
    )
      throw new Error('Collected custody and journal differ; reconcile before recovery');
    const changed = await client.query(
      `UPDATE financial_funding_plans SET status=$4,source_kind=$5
      WHERE network_genesis=$1 AND mint=$2 AND commitment=$3 AND status='prepared' AND source_kind='damm_claim' RETURNING commitment`,
      [
        proof.networkGenesis,
        proof.mint,
        proof.oldCommitment,
        proof.reuseCommitment ? 'prepared' : 'failed',
        proof.reuseCommitment ? 'collected_allocation' : 'damm_claim',
      ]
    );
    if (changed.rows.length !== 1)
      throw new Error('Exact unconsumed funding commitment is missing');
    const realization = proof.realization;
    await recordFinalizedDammWindows(client, realization);
    if (proof.reuseCommitment) {
      const existing = (
        await client.query<{ realized_net: string }>(
          `SELECT realized_net FROM financial_funding_realizations
        WHERE network_genesis=$1 AND mint=$2 AND realized_commitment=$3 FOR SHARE`,
          [proof.networkGenesis, proof.mint, proof.oldCommitment]
        )
      ).rows[0];
      if (
        proof.commitment !== proof.oldCommitment ||
        !existing ||
        BigInt(existing.realized_net) !== proof.amount
      )
        throw new Error('Modern funding recovery must preserve its immutable realized commitment');
    } else {
      await client.query(
        `INSERT INTO financial_funding_realizations(network_genesis,mint,raw_commitment,realized_commitment,raw_expected,
      realized_net,shortfall,external_lp_excluded,rounding_loss,proof_digest,proof,finalized_slot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          proof.networkGenesis,
          proof.mint,
          proof.oldCommitment,
          proof.commitment,
          realization.rawExpected.toString(),
          realization.realizedNet.toString(),
          realization.shortfall.toString(),
          realization.externalLpExcluded.toString(),
          realization.roundingLoss.toString(),
          realization.digest,
          JSON.stringify(realization, (_key, value) =>
            typeof value === 'bigint' ? value.toString() : value
          ),
          realization.slot,
        ]
      );
      await client.query(
        `INSERT INTO financial_funding_plans(network_genesis,mint,commitment,source_kind)
      VALUES($1,$2,$3,'collected_allocation')`,
        [proof.networkGenesis, proof.mint, proof.commitment]
      );
    }
    const moved = await client.query(
      proof.reuseCommitment
        ? `SELECT signature FROM financial_planned_fee_events WHERE network_genesis=$1 AND mint=$2 AND commitment=$3`
        : `UPDATE financial_planned_fee_events SET commitment=$4 WHERE network_genesis=$1 AND mint=$2
      AND commitment=$3 RETURNING signature`,
      proof.reuseCommitment
        ? [proof.networkGenesis, proof.mint, proof.oldCommitment]
        : [proof.networkGenesis, proof.mint, proof.oldCommitment, proof.commitment]
    );
    if (moved.rows.length !== (old.metadata.events as unknown[]).length)
      throw new Error('Raw event reservations changed during realization recovery');
    await client.query(
      `INSERT INTO financial_funding_recoveries(plan_id,old_signature,old_message_digest,old_transaction_base64,old_metadata,
      new_message_digest,new_transaction_base64,commitment,finalized_expiry_height,finalized_proof_slot,observed_unallocated)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        old.id,
        old.signature,
        old.message_digest,
        old.transaction_base64,
        JSON.stringify(old.metadata),
        proof.messageDigest,
        proof.transactionBase64,
        proof.commitment,
        proof.finalizedHeight,
        proof.finalizedSlot,
        proof.unallocated.toString(),
      ]
    );
    const saved = (
      await client.query<OperatorPlan>(
        `UPDATE financial_operator_plans SET transaction_base64=$2,message_digest=$3,
      last_valid_block_height=$4,metadata=$5,intent_key=$6,signature=NULL,status='prepared',finalized_slot=NULL,updated_at=now() WHERE id=$1 RETURNING *`,
        [
          old.id,
          proof.transactionBase64,
          proof.messageDigest,
          proof.lastValidBlockHeight,
          JSON.stringify(proof.metadata),
          `funding:${proof.commitment}`,
        ]
      )
    ).rows[0]!;
    await client.query('COMMIT');
    return saved;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function refreshUnsignedOperatorPlan(proof: OperatorRefresh): Promise<OperatorPlan> {
  assertOperatorRefresh(proof);
  const client = await database().connect();
  try {
    await client.query('BEGIN');
    const old = (
      await client.query<OperatorPlan>(
        'SELECT * FROM financial_operator_plans WHERE id=$1 FOR UPDATE',
        [proof.id]
      )
    ).rows[0];
    if (
      !old ||
      old.network_genesis !== proof.networkGenesis ||
      old.message_digest !== proof.oldDigest ||
      old.last_valid_block_height !== proof.oldLastValidHeight ||
      old.signature ||
      old.status !== 'prepared'
    )
      throw new Error('Unsigned operator state changed during refresh');
    await client.query(
      `INSERT INTO financial_operator_attempts(plan_id,message_digest,transaction_base64,last_valid_block_height,
      finalized_expiry_height,finalized_expiry_slot) VALUES($1,$2,$3,$4,$5,$6)`,
      [
        old.id,
        old.message_digest,
        old.transaction_base64,
        old.last_valid_block_height,
        proof.finalizedHeight,
        proof.finalizedSlot,
      ]
    );
    const saved = (
      await client.query<OperatorPlan>(
        `UPDATE financial_operator_plans SET transaction_base64=$2,message_digest=$3,
      last_valid_block_height=$4,updated_at=now() WHERE id=$1 RETURNING *`,
        [old.id, proof.transactionBase64, proof.messageDigest, proof.lastValidBlockHeight]
      )
    ).rows[0]!;
    await client.query('COMMIT');
    return saved;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function failOperatorPlan(id: string, proof: FinalizedFailure): Promise<OperatorPlan> {
  assertFinalizedFailure(proof);
  const saved = (
    await database().query<OperatorPlan>(
      `UPDATE financial_operator_plans SET status='failed',finalized_slot=$2,
    updated_at=now() WHERE id=$1 AND network_genesis=$3 AND signature=$4 AND message_digest=$5 AND status!='finalized' RETURNING *`,
      [id, proof.slot, proof.networkGenesis, proof.signature, proof.messageDigest]
    )
  ).rows[0];
  if (!saved) throw new Error('Finalized operator failure does not belong to this plan');
  return saved;
}

/** Operator signing uses this immutable prepared message, never JSON supplied to a relay endpoint. */
export async function prepareOperatorPlan(input: {
  networkGenesis: string;
  mint: string;
  kind: OperatorPlan['kind'];
  intentKey: string;
  transactionBase64: string;
  lastValidBlockHeight: number;
  metadata: Record<string, unknown>;
}): Promise<OperatorPlan> {
  const tx = VersionedTransaction.deserialize(Buffer.from(input.transactionBase64, 'base64'));
  if (
    tx.signatures.some((signature) => signature.some((value) => value !== 0)) ||
    !Number.isSafeInteger(input.lastValidBlockHeight)
  )
    throw new Error('Operator plan must be unsigned and bounded');
  const hash = messageDigest(tx.message.serialize());
  await database().query(
    `INSERT INTO financial_operator_plans(id,network_genesis,mint,kind,intent_key,transaction_base64,
    message_digest,last_valid_block_height,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
    [
      randomUUID(),
      input.networkGenesis,
      input.mint,
      input.kind,
      input.intentKey,
      input.transactionBase64,
      hash,
      input.lastValidBlockHeight,
      JSON.stringify(input.metadata),
    ]
  );
  const saved = (
    await database().query<OperatorPlan>(
      `SELECT * FROM financial_operator_plans WHERE network_genesis=$1
    AND kind=$2 AND intent_key=$3`,
      [input.networkGenesis, input.kind, input.intentKey]
    )
  ).rows[0];
  if (!saved || saved.mint !== input.mint) throw new Error('Operator intent conflicts');
  // Existing immutable message wins; a retry cannot silently replace its blockhash or authority.
  return saved;
}

export async function attachOperatorSignature(id: string, base64: string): Promise<OperatorPlan> {
  const saved = await operatorPlan(id);
  if (!saved) throw new Error('Operator plan does not exist');
  const signed = validateSignedTransaction(base64, saved.message_digest);
  if (saved.signature) {
    if (saved.signature !== signed.signature)
      throw new Error('Operator intent already has another signature');
    return saved;
  }
  const result = await database().query<OperatorPlan>(
    `UPDATE financial_operator_plans SET transaction_base64=$2,signature=$3,
    status='signed',updated_at=now() WHERE id=$1 AND status='prepared' AND signature IS NULL RETURNING *`,
    [id, base64, signed.signature]
  );
  if (result.rows[0]) return result.rows[0];
  const current = await operatorPlan(id);
  if (current?.signature === signed.signature) return current;
  throw new Error('Operator signing state changed');
}

export async function markOperatorSubmitted(id: string): Promise<OperatorPlan> {
  const result = await database().query<OperatorPlan>(
    `UPDATE financial_operator_plans SET status='submitted',updated_at=now()
    WHERE id=$1 AND status IN ('signed','submitted','manual_review') AND signature IS NOT NULL RETURNING *`,
    [id]
  );
  if (!result.rows[0]) throw new Error('Operator plan is not relayable');
  return result.rows[0];
}
export async function markOperatorUncertain(id: string): Promise<void> {
  await database().query(
    `UPDATE financial_operator_plans SET status='manual_review',updated_at=now()
    WHERE id=$1 AND status='submitted'`,
    [id]
  );
}
export async function completeOperatorPlan(
  id: string,
  evidence: FinalizedEvidence
): Promise<OperatorPlan> {
  assertFinalizedEvidence(evidence);
  const result = await database().query<OperatorPlan>(
    `UPDATE financial_operator_plans SET status='finalized',finalized_slot=$2,updated_at=now()
    WHERE id=$1 AND network_genesis=$3 AND signature=$4 AND message_digest=$5 RETURNING *`,
    [id, evidence.slot, evidence.networkGenesis, evidence.signature, evidence.messageDigest]
  );
  if (!result.rows[0]) throw new Error('Operator receipt does not belong to the prepared message');
  return result.rows[0];
}
