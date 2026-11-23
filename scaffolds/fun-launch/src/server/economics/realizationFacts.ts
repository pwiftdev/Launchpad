import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { assertDammRealization, type VerifiedDammRealization } from './dammRealization';

/** Only actual closed claim windows receive definitive integer LP/rounding classifications. */
export async function recordFinalizedDammWindows(
  client: PoolClient,
  proof: VerifiedDammRealization
) {
  assertDammRealization(proof);
  const windows = proof.windows as Array<{
    signature: string | null;
    raw: string;
    realized: string;
    external: string;
    rounding: string;
    bound: string;
    events: number;
    eventIdentityDigest: string;
  }>;
  if (!Array.isArray(windows) || windows.length > 10000)
    throw new Error('Bounded verified claim windows required');
  for (const window of windows) {
    if (!window.signature) continue;
    const policy = proof.classificationPolicy ?? 'rational-ownership-v1';
    if (!['rational-ownership-v1', 'q128-growth-v1'].includes(String(policy)))
      throw new Error('Unreviewed fee classification policy');
    const core = {
      policy,
      pool: proof.pool,
      signature: window.signature,
      eventIdentityDigest: window.eventIdentityDigest,
      events: window.events,
      raw: window.raw,
      realized: window.realized,
      external: window.external,
      rounding: window.rounding,
      bound: window.bound,
    };
    const encoded = JSON.stringify({
        ...core,
        window,
        proofDigest: proof.digest,
        historyDigest: proof.historyDigest,
      }),
      digest = createHash('sha256').update(JSON.stringify(core)).digest('hex');
    await client.query(
      `INSERT INTO financial_damm_claim_windows(network_genesis,mint,pool,claim_signature,window_digest,event_identity_digest,
      events,raw_pool_fees,realized_owned,external_lp_excluded,rounding_loss,rounding_bound,proof,verified_slot,classification_policy)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING`,
      [
        proof.networkGenesis,
        proof.mint,
        proof.pool,
        window.signature,
        digest,
        window.eventIdentityDigest,
        window.events,
        window.raw,
        window.realized,
        window.external,
        window.rounding,
        window.bound,
        encoded,
        proof.slot,
        policy,
      ]
    );
    const saved = (
      await client.query<{
        window_digest: string;
        pool: string;
        event_identity_digest: string;
        events: number;
        raw_pool_fees: string;
        realized_owned: string;
        external_lp_excluded: string;
        rounding_loss: string;
        rounding_bound: string;
      }>(
        `SELECT window_digest,pool,event_identity_digest,events,raw_pool_fees,realized_owned,external_lp_excluded,rounding_loss,rounding_bound
        FROM financial_damm_claim_windows WHERE network_genesis=$1 AND mint=$2 AND claim_signature=$3 AND classification_policy=$4`,
        [proof.networkGenesis, proof.mint, window.signature, policy]
      )
    ).rows[0];
    if (
      !saved ||
      saved.pool !== proof.pool ||
      saved.event_identity_digest !== window.eventIdentityDigest ||
      saved.events !== window.events ||
      saved.raw_pool_fees !== window.raw ||
      saved.realized_owned !== window.realized ||
      saved.external_lp_excluded !== window.external ||
      saved.rounding_loss !== window.rounding ||
      saved.rounding_bound !== window.bound
    )
      throw new Error('Finalized claim window conflicts with immutable protocol history');
  }
}
