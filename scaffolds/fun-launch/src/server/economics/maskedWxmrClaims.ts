// wXMR payouts for Masked claims. Each payment is one wallet job: the company wallet swaps the
// job's SOL for wXMR and sends exactly the quoted minimum to the claiming wallet in the same
// transaction. A claim above the per-swap limit is paid in several jobs, one at a time.
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { releaseClaim } from './maskedXmrPayouts';
import { MAXIMUM_MSKD_CONVERSION_LAMPORTS } from './walletMskdPolicy';
import type { WalletEffectFacts, WalletJob } from './walletTypes';

type Queryable = Pick<PoolClient, 'query'>;
export type WxmrAlert = { level: 'warning' | 'critical'; claimId: string; message: string };

/** Failed payments in a row before a claim stops retrying. */
export const MAXIMUM_WXMR_ATTEMPTS = 5;
const ACTIVE = ['queued', 'prepared', 'signed', 'submitted', 'manual_review'];
const PARTIAL_REVIEW = 'A partially paid claim needs review';

/** The reviewed failed job identifies exactly one round of retries. */
export async function resumeWxmrClaim(
  client: Queryable,
  network: string,
  collector: string,
  reviewedJob: string
) {
  const result = await client.query<{ id: string }>(
    `UPDATE masked_claims c SET failure=NULL,wxmr_retry_after=clock_timestamp()
     FROM wallet_jobs reviewed
     WHERE c.network_genesis=$1 AND c.currency='wxmr' AND c.status='sent' AND c.failure=$2
       AND reviewed.id=$3 AND reviewed.network_genesis=c.network_genesis AND reviewed.kind='wxmr_claim'
       AND reviewed.status='failed' AND reviewed.details->>'collector'=$4 AND reviewed.details->>'maskedClaim'=c.id::text
       AND EXISTS (SELECT 1 FROM masked_wxmr_payments p WHERE p.claim_id=c.id)
       AND NOT EXISTS (SELECT 1 FROM wallet_jobs j WHERE j.network_genesis=c.network_genesis AND j.kind='wxmr_claim'
         AND j.details->>'maskedClaim'=c.id::text AND (j.status=ANY($5::text[]) OR
           (j.status='failed' AND (j.created_at,j.id)>(reviewed.created_at,reviewed.id))))
     RETURNING c.id`,
    [network, PARTIAL_REVIEW, reviewedJob, collector, ACTIVE]
  );
  return result.rows[0]?.id ?? null;
}

/**
 * The next payment's size: the whole rest when it fits one swap, otherwise one full swap, or two
 * halves when a full swap would leave a remainder smaller than half a swap.
 */
export function nextWxmrPayment(remaining: bigint, limit = MAXIMUM_MSKD_CONVERSION_LAMPORTS) {
  if (remaining <= 0n || limit <= 0n) throw new Error('Positive wXMR payment required');
  if (remaining <= limit) return remaining;
  if (remaining < limit * 2n) return (remaining + 1n) / 2n;
  return limit;
}

type ClaimRow = {
  id: string;
  wallet: string;
  lamports: string;
  status: 'queued' | 'sent';
  paid: string;
  failures: number;
  attempts: number;
  mint: string;
  treasury: string;
  controlled: boolean;
};

/**
 * Queues the next payment for every open wXMR claim that has none in flight. Runs under the
 * payout ledger's operating lock. Claims whose coins use another company wallet are skipped.
 */
export async function queueWxmrPayments(
  client: Queryable,
  input: {
    network: string;
    collector: string;
    assetMint: string;
    market: string;
    alert?: (alert: WxmrAlert) => void;
  }
) {
  const { network } = input;
  const alert = input.alert ?? (() => {});
  const claims = (
    await client.query<ClaimRow>(
      `SELECT c.id,c.wallet,c.lamports::text,c.status,ownership.mint,ownership.treasury,ownership.controlled,
         (SELECT coalesce(sum(p.lamports),0) FROM masked_wxmr_payments p WHERE p.claim_id=c.id)::text AS paid,
         (SELECT count(*) FROM wallet_jobs j WHERE j.network_genesis=c.network_genesis AND j.kind='wxmr_claim'
            AND j.details->>'maskedClaim'=c.id::text AND j.status='failed' AND j.created_at>greatest(
              (SELECT max(p.created_at) FROM masked_wxmr_payments p WHERE p.claim_id=c.id),c.wxmr_retry_after,'-infinity'))::int AS failures,
         (SELECT count(*) FROM wallet_jobs j WHERE j.network_genesis=c.network_genesis AND j.kind='wxmr_claim' AND j.details->>'maskedClaim'=c.id::text)::int AS attempts
       FROM masked_claims c
       JOIN LATERAL (
         SELECT min(i.mint) AS mint,min(cfg.expected_leftover_receiver) AS treasury,
           bool_and(cfg.expected_fee_claimer=$3) AND count(DISTINCT cfg.expected_leftover_receiver)=1 AS controlled
         FROM masked_claim_items i JOIN launch_coins coin USING(network_genesis,mint)
         JOIN launch_configs cfg USING(network_genesis,config_key)
         WHERE i.claim_id=c.id HAVING bool_or(cfg.expected_fee_claimer=$3)
       ) ownership ON true
       WHERE c.network_genesis=$1 AND c.currency='wxmr' AND c.status IN('queued','sent')
         AND c.failure IS NULL
         AND NOT EXISTS (SELECT 1 FROM wallet_jobs j WHERE j.network_genesis=c.network_genesis AND j.kind='wxmr_claim'
           AND j.details->>'maskedClaim'=c.id::text AND j.status=ANY($2::text[]))
       ORDER BY c.created_at,c.id LIMIT 50 FOR UPDATE OF c`,
      [network, ACTIVE, input.collector]
    )
  ).rows;
  const queued: string[] = [];
  for (const claim of claims) {
    const remaining = BigInt(claim.lamports) - BigInt(claim.paid);
    if (remaining <= 0n) continue;
    if (!claim.controlled || claim.wallet === input.collector) {
      if (BigInt(claim.paid) === 0n)
        await releaseClaim(
          client,
          network,
          claim.id,
          'wXMR payout is unavailable for these earnings'
        );
      else
        await client.query('UPDATE masked_claims SET failure=$2 WHERE id=$1', [
          claim.id,
          PARTIAL_REVIEW,
        ]);
      alert({
        level: 'critical',
        claimId: claim.id,
        message: 'wXMR claim does not match this company wallet; review it',
      });
      continue;
    }
    if (claim.failures >= MAXIMUM_WXMR_ATTEMPTS) {
      if (BigInt(claim.paid) === 0n) {
        // Nothing was paid, so the earnings go back to the wallet to claim again.
        await releaseClaim(client, network, claim.id, 'wXMR payouts failed; claim again');
        alert({
          level: 'warning',
          claimId: claim.id,
          message: 'wXMR claim returned after repeated failed payments',
        });
      } else {
        await client.query('UPDATE masked_claims SET failure=$2 WHERE id=$1', [
          claim.id,
          PARTIAL_REVIEW,
        ]);
        alert({
          level: 'critical',
          claimId: claim.id,
          message: `wXMR claim partly paid and stopped after ${claim.failures} failed payments; review it`,
        });
      }
      continue;
    }
    const job = randomUUID();
    await client.query(
      `INSERT INTO wallet_jobs(id,network_genesis,mint,kind,intent_key,bucket,recipient,epoch,lamports,details,created_at)
       VALUES($1,$2,$3,'wxmr_claim',$4,NULL,$5,NULL,$6,$7,clock_timestamp())`,
      [
        job,
        network,
        claim.mint,
        `masked-wxmr:${claim.id}:${claim.attempts}`,
        claim.wallet,
        nextWxmrPayment(remaining).toString(),
        JSON.stringify({
          collector: input.collector,
          treasury: claim.treasury,
          maskedClaim: claim.id,
          assetMint: input.assetMint,
          market: input.market,
        }),
      ]
    );
    if (claim.status === 'queued')
      await client.query(`UPDATE masked_claims SET status='sent' WHERE id=$1`, [claim.id]);
    queued.push(job);
  }
  return queued;
}

type Payment = {
  claim_id: string;
  recipient: string;
  signature: string;
  finalized_slot: string;
  lamports: string;
  payout_units: string;
};

/**
 * Settles one finalized wXMR payment: the claim's reserved creator and holder SOL becomes spent,
 * coin by coin, up to the payment's amount. The last payment marks the claim paid and records
 * the total wXMR it delivered. The caller holds the operating lock.
 */
export async function settleWxmrPayment(
  client: Queryable,
  job: WalletJob,
  effect: WalletEffectFacts
) {
  const lamports = BigInt(job.lamports);
  const units = effect.receivedPayoutUnits;
  if (
    job.kind !== 'wxmr_claim' ||
    effect.kind !== 'wxmr_claim' ||
    !job.recipient ||
    effect.recipient !== job.recipient ||
    effect.paidLamports !== lamports ||
    effect.collectorDebitLamports !== lamports ||
    !units ||
    units <= 0n
  )
    throw new Error('Verified wXMR payment differs from its job');
  const claimId = String(job.details.maskedClaim);
  const previous = (
    await client.query<Payment>(
      'SELECT *,lamports::text,payout_units::text FROM masked_wxmr_payments WHERE job_id=$1',
      [job.id]
    )
  ).rows[0];
  if (previous) {
    if (
      previous.claim_id !== claimId ||
      previous.signature !== effect.signature ||
      Number(previous.finalized_slot) !== effect.slot ||
      BigInt(previous.lamports) !== lamports ||
      BigInt(previous.payout_units) !== units
    )
      throw new Error('A different wXMR payment is already recorded for this job');
    return;
  }
  const claim = (
    await client.query<{ wallet: string; lamports: string; status: string; currency: string }>(
      `SELECT wallet,lamports::text,status,currency FROM masked_claims WHERE id=$1 AND network_genesis=$2 FOR UPDATE`,
      [claimId, job.network_genesis]
    )
  ).rows[0];
  if (
    !claim ||
    claim.currency !== 'wxmr' ||
    claim.wallet !== job.recipient ||
    claim.status !== 'sent'
  )
    throw new Error('wXMR payment has no open claim');
  const owed = (
    await client.query<{ mint: string; bucket: 'creator' | 'community'; owed: string }>(
      `SELECT i.mint,CASE WHEN i.kind='creator' THEN 'creator' ELSE 'community' END AS bucket,
         (sum(i.lamports)-coalesce((SELECT sum(s.lamports) FROM masked_wxmr_settlements s
           WHERE s.claim_id=$1 AND s.mint=i.mint AND s.bucket=CASE WHEN i.kind='creator' THEN 'creator' ELSE 'community' END),0))::text AS owed
       FROM masked_claim_items i WHERE i.claim_id=$1 GROUP BY i.mint,i.kind ORDER BY i.mint,i.kind`,
      [claimId]
    )
  ).rows;
  for (const mint of [...new Set(owed.map((row) => row.mint))].sort())
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `wallet-settlement:${job.network_genesis}:${mint}`,
    ]);
  await client.query(
    `INSERT INTO masked_wxmr_payments(job_id,claim_id,network_genesis,recipient,signature,finalized_slot,lamports,payout_units)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      job.id,
      claimId,
      job.network_genesis,
      job.recipient,
      effect.signature,
      effect.slot,
      lamports.toString(),
      units.toString(),
    ]
  );
  let left = lamports;
  for (const row of owed) {
    const take = left < BigInt(row.owed) ? left : BigInt(row.owed);
    if (take <= 0n) continue;
    const moved = await client.query(
      `UPDATE wallet_balances SET reserved=reserved-$4,spent=spent+$4
       WHERE network_genesis=$1 AND mint=$2 AND bucket=$3 AND reserved>=$4 RETURNING mint`,
      [job.network_genesis, row.mint, row.bucket, take.toString()]
    );
    if (!moved.rows.length) throw new Error('A wXMR payment is missing its reservation');
    await client.query(
      `INSERT INTO masked_wxmr_settlements(job_id,claim_id,network_genesis,mint,bucket,lamports) VALUES($1,$2,$3,$4,$5,$6)`,
      [job.id, claimId, job.network_genesis, row.mint, row.bucket, take.toString()]
    );
    left -= take;
  }
  if (left !== 0n) throw new Error('wXMR payment exceeds what the claim reserved');
  const totals = (
    await client.query<{ lamports: string; units: string }>(
      `SELECT sum(lamports)::text AS lamports,sum(payout_units)::text AS units FROM masked_wxmr_payments WHERE claim_id=$1`,
      [claimId]
    )
  ).rows[0]!;
  if (BigInt(totals.lamports) === BigInt(claim.lamports))
    await client.query(`UPDATE masked_claims SET status='paid',xmr_atomic=$2 WHERE id=$1`, [
      claimId,
      totals.units,
    ]);
}
