import type { PoolClient } from 'pg';

type Queryable = Pick<PoolClient, 'query'>;
type Holder = { networkGenesis: string; mint: string; wallet: string };

const CLAIMABLE = `FROM wallet_allocations a
 JOIN wallet_epochs e USING(network_genesis,mint,epoch)
 WHERE a.network_genesis=$1 AND a.mint=$2 AND a.wallet=$3 AND e.asset_mint=$4
 AND NOT EXISTS (
   SELECT 1 FROM wallet_claim_allocations c JOIN wallet_jobs j ON j.id=c.job_id
   WHERE (c.network_genesis,c.mint,c.wallet,c.epoch)=(a.network_genesis,a.mint,a.wallet,a.epoch)
   AND j.status<>'failed'
 )`;

export async function holderClaimTotal(db: Queryable, holder: Holder, assetMint: string) {
  return (
    await db.query<{ amount: string; source: string; throughEpoch: string | null }>(
      `SELECT coalesce(sum(a.lamports),0)::text AS amount,coalesce(sum(coalesce(a.source_lamports,a.lamports)),0)::text AS source,max(a.epoch)::text AS "throughEpoch" ${CLAIMABLE}`,
      [holder.networkGenesis, holder.mint, holder.wallet, assetMint]
    )
  ).rows[0]!;
}

export async function attachHolderAllocations(
  db: Queryable,
  holder: Holder,
  assetMint: string,
  throughEpoch: number,
  jobId: string,
  exactAmount: bigint,
  minimumSource: bigint
) {
  const recorded = (
    await db.query<{ amount: string; source: string; throughEpoch: string | null }>(
      `WITH claimable AS (
         SELECT a.network_genesis,a.mint,a.epoch,a.wallet,a.lamports,coalesce(a.source_lamports,a.lamports) AS source ${CLAIMABLE} AND a.epoch<=$5
       ), reserved AS (
         INSERT INTO wallet_claim_allocations(job_id,network_genesis,mint,epoch,wallet)
         SELECT $6,network_genesis,mint,epoch,wallet FROM claimable RETURNING epoch
       )
       SELECT coalesce(sum(claimable.lamports),0)::text AS amount,coalesce(sum(claimable.source),0)::text AS source,max(reserved.epoch)::text AS "throughEpoch"
       FROM reserved JOIN claimable USING(epoch)`,
      [holder.networkGenesis, holder.mint, holder.wallet, assetMint, throughEpoch, jobId]
    )
  ).rows[0]!;
  if (
    BigInt(recorded.amount) !== exactAmount ||
    BigInt(recorded.source) < minimumSource ||
    Number(recorded.throughEpoch) !== throughEpoch
  )
    throw new Error('The exact funded holder reward changed. Refresh your balance.');
}

export const batchedHolderJobJoin = `
 LEFT JOIN wallet_claim_allocations c
   ON (c.network_genesis,c.mint,c.epoch,c.wallet)=(a.network_genesis,a.mint,a.epoch,a.wallet)
   AND EXISTS (SELECT 1 FROM wallet_jobs active WHERE active.id=c.job_id AND active.status<>'failed')
 LEFT JOIN wallet_jobs j ON j.id=c.job_id`;
