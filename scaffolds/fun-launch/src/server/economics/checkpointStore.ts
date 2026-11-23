import type { Pool, PoolClient } from 'pg';
import { database } from '../database';
import type { DammCheckpointStore } from './dammRealization';
import {
  assertVerifiedDammCheckpoint,
  type DammCheckpointIdentity,
  type StoredDammCheckpoint,
  type VerifiedDammCheckpoint,
} from './dammCheckpoint';
import type { EventId } from './financialStore';
import { DammProofCapacityError, DAMM_PROOF_LIMITS } from './dammProofCapacity';

type CheckpointRow = {
  envelope: StoredDammCheckpoint;
  checkpoint_digest: string;
  payload_digest: string;
  mac: string;
  cursor_signature: string;
  cursor_slot: string;
  cursor_transaction_index: number;
  previous_checkpoint_digest: string | null;
  payload: Record<string, unknown>;
};
const keys = (identity: DammCheckpointIdentity) => [
  identity.networkGenesis,
  identity.programId,
  identity.mint,
  identity.pool,
  identity.position,
  identity.classificationPolicy,
];
const scope = `network_genesis=$1 AND program_id=$2 AND mint=$3 AND pool=$4 AND position=$5 AND classification_policy=$6`;
const fields =
  'envelope,checkpoint_digest,payload_digest,mac,cursor_signature,cursor_slot,cursor_transaction_index,previous_checkpoint_digest,payload';

function envelope(row: CheckpointRow, identity: DammCheckpointIdentity): StoredDammCheckpoint {
  const value = row.envelope;
  if (
    !value ||
    keys(value).some((field, index) => field !== keys(identity)[index]) ||
    value.digest !== row.checkpoint_digest ||
    value.payloadDigest !== row.payload_digest ||
    value.mac !== row.mac ||
    value.cursorSignature !== row.cursor_signature ||
    String(value.cursorSlot) !== String(row.cursor_slot) ||
    value.cursorTransactionIndex !== row.cursor_transaction_index ||
    value.previousCheckpointDigest !== row.previous_checkpoint_digest ||
    JSON.stringify(value.payload) !== JSON.stringify(row.payload)
  )
    throw new Error('Checkpoint SQL envelope metadata differs; restore verified evidence');
  // The replay helper independently verifies the MAC and exact finalized cursor before trusting this data.
  return value;
}

/** Immutable authenticated checkpoint storage; MAC verification stays in the replay helper. */
export class FinancialDammCheckpointStore implements DammCheckpointStore {
  constructor(private readonly supplied?: Pick<Pool, 'query' | 'connect'>) {}
  private get db() {
    return this.supplied ?? database();
  }
  async loadLatest(identity: DammCheckpointIdentity): Promise<StoredDammCheckpoint | null> {
    const row = (
      await this.db.query<CheckpointRow>(
        `SELECT ${fields} FROM financial_damm_replay_checkpoints WHERE ${scope}
      ORDER BY cursor_slot DESC,cursor_transaction_index DESC LIMIT 1`,
        keys(identity)
      )
    ).rows[0];
    return row ? envelope(row, identity) : null;
  }
  async loadAttributions(
    identity: DammCheckpointIdentity,
    eventIds: EventId[]
  ): Promise<StoredDammCheckpoint[]> {
    if (!eventIds.length) return [];
    if (eventIds.length > DAMM_PROOF_LIMITS.events)
      throw new DammProofCapacityError('events', eventIds.length, DAMM_PROOF_LIMITS.events);
    const rows = (
      await this.db.query<CheckpointRow>(
        `SELECT ${fields} FROM financial_damm_replay_checkpoints
      WHERE ${scope} AND EXISTS(SELECT 1 FROM jsonb_array_elements($7::jsonb) AS requested(id)
        WHERE payload->'attributions' @> jsonb_build_array(requested.id))
      ORDER BY cursor_slot,cursor_transaction_index LIMIT $8`,
        [...keys(identity), JSON.stringify(eventIds), DAMM_PROOF_LIMITS.transactions + 1]
      )
    ).rows;
    if (rows.length > DAMM_PROOF_LIMITS.transactions)
      throw new DammProofCapacityError('transactions', rows.length, DAMM_PROOF_LIMITS.transactions);
    return rows.map((row) => envelope(row, identity));
  }
  async save(checkpoint: VerifiedDammCheckpoint): Promise<void> {
    assertVerifiedDammCheckpoint(checkpoint);
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        keys(checkpoint).join(':'),
      ]);
      await this.saveLocked(client, checkpoint);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  private async saveLocked(client: PoolClient, checkpoint: VerifiedDammCheckpoint) {
    const existing = (
      await client.query<CheckpointRow>(
        `SELECT ${fields} FROM financial_damm_replay_checkpoints
      WHERE ${scope} AND checkpoint_digest=$7`,
        [...keys(checkpoint), checkpoint.digest]
      )
    ).rows[0];
    if (existing) {
      envelope(existing, checkpoint);
      return;
    }
    const latest = (
      await client.query<CheckpointRow>(
        `SELECT ${fields} FROM financial_damm_replay_checkpoints WHERE ${scope}
      ORDER BY cursor_slot DESC,cursor_transaction_index DESC LIMIT 1 FOR UPDATE`,
        keys(checkpoint)
      )
    ).rows[0];
    if (
      (latest?.checkpoint_digest ?? null) !== checkpoint.previousCheckpointDigest ||
      (latest &&
        (checkpoint.cursorSlot < Number(latest.cursor_slot) ||
          (checkpoint.cursorSlot === Number(latest.cursor_slot) &&
            checkpoint.cursorTransactionIndex <= latest.cursor_transaction_index)))
    )
      throw new Error(
        'Replay checkpoint advanced or cursor regressed; retry from the latest verified state'
      );
    await client.query(
      `INSERT INTO financial_damm_replay_checkpoints(network_genesis,program_id,mint,pool,position,classification_policy,
      checkpoint_digest,payload_digest,mac,cursor_signature,cursor_slot,cursor_transaction_index,previous_checkpoint_digest,rolling_history_digest,
      verified_snapshot_slot,pool_digest,position_digest,payload,envelope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        ...keys(checkpoint),
        checkpoint.digest,
        checkpoint.payloadDigest,
        checkpoint.mac,
        checkpoint.cursorSignature,
        checkpoint.cursorSlot,
        checkpoint.cursorTransactionIndex,
        checkpoint.previousCheckpointDigest,
        checkpoint.rollingHistoryDigest,
        checkpoint.verifiedSnapshotSlot,
        checkpoint.poolDigest,
        checkpoint.positionDigest,
        JSON.stringify(checkpoint.payload),
        JSON.stringify(checkpoint),
      ]
    );
  }
}
