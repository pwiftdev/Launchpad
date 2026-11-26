import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { allocateHolderSnapshot, eligibleHolderBalances } from './feeLedger';
import type { FinalizedHolderSnapshot } from './holderSnapshot';
import type { WalletEffectFacts, WalletJob } from './walletTypes';
import { HSOL_REWARD_MINT } from '@/lib/rewards';

type Queryable = Pick<PoolClient, 'query'>;

export async function insertMskdConversion(
  db: Queryable,
  snapshot: FinalizedHolderSnapshot,
  details: {
    assetMint: string;
    market: string;
    collector: string;
    treasury: string;
    sourceMint?: string;
  },
  epoch: number,
  budget: bigint
) {
  const weights = [...eligibleHolderBalances(snapshot)].map(([wallet, weight]) => ({
    wallet,
    weight: weight.toString(),
  }));
  if (!weights.length) return null;
  const job = (
    await db.query<WalletJob>(
      `INSERT INTO wallet_jobs(id,network_genesis,mint,kind,intent_key,bucket,lamports,details)
       VALUES($1,$2,$3,'holder_conversion',$4,'community',$5,$6)
       ON CONFLICT DO NOTHING RETURNING *`,
      [
        randomUUID(),
        snapshot.networkGenesis,
        snapshot.mint,
        `holder-conversion:${epoch}`,
        budget.toString(),
        JSON.stringify(details),
      ]
    )
  ).rows[0];
  if (!job) return null;
  await db.query(
    `INSERT INTO wallet_mskd_snapshots(job_id,network_genesis,mint,epoch,snapshot_slot,snapshot_time,snapshot_digest,payout_mint,excluded_owners,owner_weights)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      job.id,
      snapshot.networkGenesis,
      snapshot.mint,
      epoch,
      snapshot.slot,
      snapshot.blockTime,
      snapshot.digest,
      details.assetMint,
      JSON.stringify([...snapshot.excluded].sort()),
      JSON.stringify(weights),
    ]
  );
  await db.query(
    `UPDATE wallet_balances SET reserved=reserved+$3 WHERE network_genesis=$1 AND mint=$2 AND bucket='community'`,
    [snapshot.networkGenesis, snapshot.mint, budget.toString()]
  );
  return job;
}

type MskdSnapshot = {
  epoch: string;
  snapshot_slot: string;
  snapshot_time: string;
  snapshot_digest: string;
  payout_mint: string;
  excluded_owners: string[];
  owner_weights: { wallet: string; weight: string }[];
};

export async function settleMskdConversion(
  db: Queryable,
  job: WalletJob,
  effect: WalletEffectFacts
) {
  const spent = effect.collectorDebitLamports;
  const received = effect.receivedPayoutUnits;
  const reserved = BigInt(job.lamports);
  if (
    !spent ||
    spent <= 0n ||
    spent > reserved ||
    (job.details.sourceMint !== HSOL_REWARD_MINT && spent !== reserved) ||
    !received ||
    received <= 0n ||
    received > 18446744073709551615n
  )
    throw new Error('Verified conversion differs from its reserved budget');
  const receipt = (
    await db.query<{
      signature: string;
      finalized_slot: string;
      spent_lamports: string;
      received_units: string;
    }>('SELECT * FROM wallet_mskd_conversions WHERE job_id=$1', [job.id])
  ).rows[0];
  if (job.status === 'finalized') {
    if (
      !receipt ||
      receipt.signature !== effect.signature ||
      Number(receipt.finalized_slot) !== effect.slot ||
      BigInt(receipt.spent_lamports) !== spent ||
      BigInt(receipt.received_units) !== received
    )
      throw new Error('Verified effect conflicts with the finalized conversion');
    return;
  }
  const snapshot = (
    await db.query<MskdSnapshot>(
      'SELECT * FROM wallet_mskd_snapshots WHERE job_id=$1 AND network_genesis=$2 AND mint=$3',
      [job.id, job.network_genesis, job.mint]
    )
  ).rows[0];
  if (
    !snapshot ||
    snapshot.payout_mint !== job.details.assetMint ||
    effect.slot < Number(snapshot.snapshot_slot)
  )
    throw new Error('Conversion differs from its immutable holder snapshot');
  const prior = (
    await db.query<{ epoch: string; carry: string; source_carry_lamports: string }>(
      `SELECT epoch,carry,source_carry_lamports FROM wallet_epochs WHERE network_genesis=$1 AND mint=$2 AND asset_mint=$3 ORDER BY epoch DESC LIMIT 1`,
      [job.network_genesis, job.mint, snapshot.payout_mint]
    )
  ).rows[0];
  if (prior && BigInt(prior.epoch) >= BigInt(snapshot.epoch))
    throw new Error('MSKD reward hours must settle in order');
  const carry = BigInt(prior?.carry ?? 0);
  const sourceBudget = spent + BigInt(prior?.source_carry_lamports ?? 0);
  const budget = received + carry;
  const allocation = allocateHolderSnapshot(budget, {
    complete: true,
    finalized: true,
    excluded: new Set(),
    balances: snapshot.owner_weights.map(({ wallet, weight }) => ({
      wallet,
      tokens: BigInt(weight),
    })),
  });
  const rows = allocation.allocations.map(({ wallet, lamports }) => ({
    wallet,
    units: lamports.toString(),
    source: ((lamports * sourceBudget) / budget).toString(),
  }));
  const attributed = rows.reduce((sum, row) => sum + BigInt(row.source), 0n);
  const keys = [job.network_genesis, job.mint, snapshot.epoch];
  await db.query(
    `INSERT INTO wallet_epochs(network_genesis,mint,epoch,snapshot_slot,snapshot_time,snapshot_digest,budget,allocated,carry,snapshot_exclusions,asset_mint,source_carry_lamports)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      ...keys,
      snapshot.snapshot_slot,
      snapshot.snapshot_time,
      snapshot.snapshot_digest,
      budget.toString(),
      (budget - allocation.carryForward).toString(),
      allocation.carryForward.toString(),
      JSON.stringify(snapshot.excluded_owners),
      snapshot.payout_mint,
      (sourceBudget - attributed).toString(),
    ]
  );
  await db.query(
    `INSERT INTO wallet_allocations(network_genesis,mint,epoch,wallet,lamports,source_lamports)
     SELECT $1,$2,$3,wallet,units::numeric,source::numeric
     FROM jsonb_to_recordset($4::jsonb) AS holders(wallet text,units text,source text)`,
    [...keys, JSON.stringify(rows)]
  );
  await db.query(
    `INSERT INTO wallet_mskd_conversions(job_id,signature,finalized_slot,spent_lamports,received_units)VALUES($1,$2,$3,$4,$5)`,
    [job.id, effect.signature, effect.slot, spent.toString(), received.toString()]
  );
  await db.query(
    `UPDATE wallet_balances SET reserved=reserved-$3,spent=spent+$4 WHERE network_genesis=$1 AND mint=$2 AND bucket='community'`,
    [job.network_genesis, job.mint, reserved.toString(), spent.toString()]
  );
}

export async function mskdTokenLiability(
  db: Queryable,
  genesis: string,
  collector: string,
  mint: string
) {
  const row = (
    await db.query<{ liability: string; slot: string }>(
      `WITH converted AS (
       SELECT coalesce(sum(c.received_units),0) AS amount,coalesce(max(c.finalized_slot),0) AS slot
       FROM wallet_mskd_conversions c JOIN wallet_mskd_snapshots s USING(job_id) JOIN wallet_jobs j ON j.id=c.job_id
       WHERE s.network_genesis=$1 AND j.details->>'collector'=$2 AND s.payout_mint=$3
     ), paid AS (
       SELECT coalesce(sum(j.lamports),0) AS amount,coalesce(max(j.finalized_slot),0) AS slot
       FROM wallet_jobs j WHERE j.network_genesis=$1 AND j.details->>'collector'=$2 AND j.details->>'assetMint'=$3
       AND j.kind='community_claim' AND j.status='finalized' AND j.details ? 'assetMint'
     ) SELECT (converted.amount-paid.amount)::text AS liability,greatest(converted.slot,paid.slot)::text AS slot FROM converted CROSS JOIN paid`,
      [genesis, collector, mint]
    )
  ).rows[0]!;
  return { liability: BigInt(row.liability), minimumSlot: Number(row.slot) };
}
