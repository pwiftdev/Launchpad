import type { Pool } from 'pg';
import { database } from './database';
import type { LaunchPolicyVersion } from '@/lib/launchModes';

/** Finalized settlement rows are admitted only after the exact received tokens were burned. */
export async function readBurnReceipts(
  genesis: string,
  pool: Pick<Pool, 'query'> = database(),
  policyVersion?: LaunchPolicyVersion
) {
  const eligible = `network_genesis=$1 AND kind='buyback' AND status='finalized'
    AND expectations->>'effect'='buyback_burn' AND received_tokens>0
    AND signature IS NOT NULL AND finalized_slot IS NOT NULL`;
  const source = `WITH wallet_burns AS (
    SELECT j.mint,j.signature,j.finalized_slot,s.actual_spent_lamports AS lamports,
      s.burned_tokens AS token_units
      FROM wallet_jobs j JOIN wallet_settlements s
        ON s.job_id=j.id AND s.network_genesis=j.network_genesis AND s.mint=j.mint
        AND s.kind=j.kind AND s.signature=j.signature AND s.message_digest=j.message_digest
        AND s.finalized_slot=j.finalized_slot AND s.burned_tokens=j.burned_tokens
      WHERE j.network_genesis=$1 AND j.kind='buyback' AND j.status='finalized'
        AND j.expectations->>'effect'='buyback_burn' AND j.burned_tokens>0
        AND s.actual_spent_lamports>0 AND s.actual_spent_lamports<=j.lamports
  ), finalized_burns AS (
    SELECT mint,signature,finalized_slot,lamports,received_tokens AS token_units
      FROM financial_jobs WHERE ${eligible}
        AND NOT EXISTS (SELECT 1 FROM wallet_burns w
          WHERE w.mint=financial_jobs.mint AND w.signature=financial_jobs.signature)
    UNION
    SELECT mint,signature,finalized_slot,lamports,token_units FROM wallet_burns
  )${
    policyVersion
      ? `, visible_burns AS (
    SELECT b.* FROM finalized_burns b WHERE EXISTS (
      SELECT 1 FROM launch_coins c WHERE c.network_genesis=$1 AND c.mint=b.mint AND c.policy_version=$2
    )
  )`
      : ''
  }`;
  const visible = policyVersion ? 'visible_burns' : 'finalized_burns';
  const parameters = policyVersion ? [genesis, policyVersion] : [genesis];
  const [totals, receipts] = await Promise.all([
    pool.query<{ coins: string; buybacks: string; lamports: string }>(
      `${source} SELECT count(DISTINCT mint)::text AS coins,count(*)::text AS buybacks,
       COALESCE(sum(lamports),0)::text AS lamports FROM ${visible}`,
      parameters
    ),
    pool.query<{
      mint: string;
      signature: string;
      finalizedSlot: string;
      lamports: string;
      tokenUnits: string;
    }>(
      `${source} SELECT mint,signature,finalized_slot::text AS "finalizedSlot",lamports::text,
       token_units::text AS "tokenUnits" FROM ${visible}
       ORDER BY finalized_slot DESC,signature DESC LIMIT 50`,
      parameters
    ),
  ]);
  return { networkGenesis: genesis, totals: totals.rows[0]!, receipts: receipts.rows, limit: 50 };
}
