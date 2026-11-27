import {
  hasBatchedHolderRewards,
  hasCreatorRewards,
  isCashbackMode,
  isMaskedMode,
  isMskdMode,
} from '@/lib/launchModes';
import { isHsolMode } from '@/lib/feeModes';
import { HSOL_REWARD_MINT, MINIMUM_HOLDER_PAYOUT_LAMPORTS } from '@/lib/rewards';
import { companyWallets } from '../../../../../scripts/company-wallets.cjs';
import bondPolicy from '@/constants/bondPolicy.json';
import { WalletOperatingUnavailable } from './walletPolicy';
import { createHash, randomUUID } from 'node:crypto';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import type { Pool, PoolClient } from 'pg';
import { database } from '../database';
import type { RegisteredCoin } from '../launchRegistry';
import { verifiedFinancialPool } from '../migrationRegistry';
import { assertVerifiedFee, type VerifiedFeeEvent } from './feeIngestion';
import { allocateExecutedFee, allocateHolderSnapshot, timeWeightedBalances } from './feeLedger';
import { assertHolderSnapshot, type FinalizedHolderSnapshot } from './holderSnapshot';
import {
  messageDigest,
  validateSignedTransaction,
  assertFinalizedFailure,
  type FinalizedFailure,
} from './chainEvidence';
import type { FinancialIndexCursor } from './financialStore';
import type {
  WalletBalance,
  WalletBucket,
  WalletFeeObservation,
  WalletJob,
  PreparedWalletExecution,
  WalletEffectFacts,
} from './walletTypes';
import { assertVerifiedWalletEffect } from './walletEvidence';
import { assertWalletRecoveryProof, type WalletRecoveryProof } from './walletRecovery';
import {
  attachHolderAllocations,
  batchedHolderJobJoin,
  holderClaimTotal,
} from './walletHolderClaims';
import { insertMskdConversion, settleMskdConversion, mskdTokenLiability } from './walletMskdStore';
import { queueWxmrPayments, settleWxmrPayment, type WxmrAlert } from './maskedWxmrClaims';
import {
  MAXIMUM_MSKD_CONVERSION_LAMPORTS,
  mskdConversionPool,
  mskdPayoutMint,
  signedRewardMint,
} from './walletMskdPolicy';
export type { WalletJob, WalletBalance } from './walletTypes';

const ACTIVE = ['queued', 'prepared', 'signed', 'submitted', 'manual_review'];
/** Masked holder samples: one per five-minute window, at least half an hour's worth per epoch. */
export const MASKED_SAMPLE_SECONDS = 300;
export const MASKED_MINIMUM_SAMPLES = 6;
const BUCKETS: WalletBucket[] = [
  'rinse_buyback',
  'creator',
  'community',
  'platform',
  'mskd_buyback',
];
const amount = (value: bigint) => {
  if (value <= 0n || value > 18446744073709551615n)
    throw new Error('Invalid wallet settlement amount');
  return value.toString();
};
const publicKey = (value: string) => {
  if (new PublicKey(value).toBase58() !== value) throw new Error('Invalid public address');
  return value;
};
type WalletCoin = RegisteredCoin & { collector: string; treasury: string };
export type WalletEpoch = {
  network_genesis: string;
  mint: string;
  epoch: string;
  snapshot_slot: string;
  snapshot_time: string;
  snapshot_digest: string;
  budget: string;
  allocated: string;
  carry: string;
};
export type WalletRewardsView = {
  mode: import('@/lib/launchModes').LaunchMode;
  availableLamports: string;
  paidLamports: string;
  holderClaim?: { amount: string; throughEpoch: string; assetMint: string } | null;
  epochs: Array<{
    epoch: string;
    lamports: string;
    snapshot_slot: string;
    snapshot_digest: string;
    status: 'available' | 'queued' | 'paid';
    jobId: string | null;
    signature: string | null;
    conversion_signature?: string;
  }>;
  pendingPayout: WalletJob | null;
  receipts: Array<{ id: string; lamports: string; signature: string; finalizedSlot: string }>;
};
const UNCONSUMED = `NOT EXISTS(SELECT 1 FROM wallet_collected_events done WHERE done.network_genesis=e.network_genesis AND done.signature=e.signature AND done.instruction_index=e.instruction_index AND done.event_index=e.event_index)
 AND NOT EXISTS(SELECT 1 FROM wallet_collection_cursors cut WHERE cut.network_genesis=e.network_genesis AND cut.pool=e.pool AND
 (e.finalized_slot<cut.finalized_slot OR(e.finalized_slot=cut.finalized_slot AND cut.slot_signatures ? e.signature)))`;

/** Central-wallet accounting only. A row is never a promise of program-enforced custody. */
export class WalletStore {
  constructor(private readonly supplied?: Pick<Pool, 'query' | 'connect'>) {}
  private get db() {
    return this.supplied ?? database();
  }
  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  private async lock(client: PoolClient, network: string, mint: string) {
    // Operations may be funded across Bond it. coins belonging to the same collector.
    // A consistent global-before-coin lock order also protects treasury reservations.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `wallet-operating:${network}`,
    ]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `wallet-settlement:${network}:${mint}`,
    ]);
  }
  private async coin(
    client: Pick<PoolClient, 'query'>,
    network: string,
    mint: string,
    historicalRead = false
  ): Promise<WalletCoin> {
    const row = (
      await client.query<WalletCoin>(
        `SELECT c.*,cfg.expected_fee_claimer AS collector,cfg.expected_leftover_receiver AS treasury FROM launch_coins c
   JOIN launch_configs cfg ON(cfg.network_genesis=c.network_genesis AND cfg.config_key=c.config_key)
   WHERE c.network_genesis=$1 AND c.mint=$2 AND c.policy_version IN('wallet-v1','bond-v1','dev-v1','cashback-v1','mskd-v1','hsol-v1','cashback-hsol-v1','mskd-hsol-v1','masked-v1') AND cfg.policy_version=c.policy_version`,
        [network, mint]
      )
    ).rows[0];
    if (!row) throw new Error('Reviewed wallet-v1 registry identity is required');
    if (historicalRead) {
      companyWallets(
        {
          FEE_COLLECTOR_PUBLIC_KEY: row.collector,
          TREASURY_PUBLIC_KEY: row.treasury,
          LAUNCH_POLICY_VERSION: row.policy_version,
        },
        network,
        { allowLegacy: row.policy_version === 'wallet-v1' }
      );
      return row;
    }
    if (
      (process.env.FEE_COLLECTOR_PUBLIC_KEY &&
        row.collector !== process.env.FEE_COLLECTOR_PUBLIC_KEY) ||
      (process.env.TREASURY_PUBLIC_KEY && row.treasury !== process.env.TREASURY_PUBLIC_KEY)
    )
      throw new Error('Reviewed wallet-v1 registry identity is required');
    return row;
  }
  private async balance(client: PoolClient, network: string, mint: string, bucket: WalletBucket) {
    await client.query(
      'INSERT INTO wallet_balances(network_genesis,mint,bucket)VALUES($1,$2,$3)ON CONFLICT DO NOTHING',
      [network, mint, bucket]
    );
    return (
      await client.query<{ funded: string; reserved: string; spent: string }>(
        'SELECT funded::text,reserved::text,spent::text FROM wallet_balances WHERE network_genesis=$1 AND mint=$2 AND bucket=$3 FOR UPDATE',
        [network, mint, bucket]
      )
    ).rows[0]!;
  }
  async balances(network: string, mint: string): Promise<WalletBalance[]> {
    await this.coin(this.db, network, mint);
    return this.balanceRows(network, mint);
  }
  private async balanceRows(network: string, mint: string): Promise<WalletBalance[]> {
    return (
      await this.db.query<WalletBalance>(
        `SELECT bucket,funded::text,reserved::text,spent::text,(funded-reserved-spent)::text AS available FROM wallet_balances WHERE network_genesis=$1 AND mint=$2 ORDER BY bucket`,
        [network, mint]
      )
    ).rows;
  }
  async liabilities(network: string, collector: string): Promise<bigint> {
    return BigInt(
      (
        await this.db.query<{ liability: string }>(
          `SELECT coalesce(sum(b.funded-b.spent),0)::text AS liability FROM wallet_balances b JOIN launch_coins c USING(network_genesis,mint)
  JOIN launch_configs cfg ON(cfg.network_genesis=c.network_genesis AND cfg.config_key=c.config_key) WHERE b.network_genesis=$1 AND cfg.expected_fee_claimer=$2 AND c.policy_version NOT IN('hsol-v1','cashback-hsol-v1','mskd-hsol-v1') AND c.policy_version IN('wallet-v1','bond-v1','dev-v1','cashback-v1','mskd-v1','hsol-v1','cashback-hsol-v1','mskd-hsol-v1','masked-v1')`,
          [network, collector]
        )
      ).rows[0]!.liability
    );
  }
  async custodyRequirement(
    network: string,
    collector: string
  ): Promise<{ liability: bigint; operating: bigint; minimumSlot: number }> {
    const row = (
      await this.db.query<{ liability: string; operating: string; slot: string }>(
        `WITH coins AS(SELECT c.network_genesis,c.mint,c.policy_version FROM launch_coins c JOIN launch_configs cfg ON(cfg.network_genesis=c.network_genesis AND cfg.config_key=c.config_key)WHERE c.network_genesis=$1 AND cfg.expected_fee_claimer=$2 AND c.policy_version IN('wallet-v1','bond-v1','dev-v1','cashback-v1','mskd-v1','hsol-v1','cashback-hsol-v1','mskd-hsol-v1','masked-v1') AND cfg.policy_version=c.policy_version), liabilities AS(SELECT coalesce(sum(CASE WHEN coins.policy_version IN('hsol-v1','cashback-hsol-v1','mskd-hsol-v1') THEN 0 WHEN coins.policy_version='bond-v1' AND b.bucket='platform' THEN b.reserved ELSE b.funded-b.spent END),0)::text AS liability FROM wallet_balances b JOIN coins USING(network_genesis,mint)),operations AS(SELECT coalesce(sum(CASE WHEN j.status=ANY($3::text[]) THEN coalesce(j.expectations->>'operatingCostLamports','0')::numeric + greatest(coalesce(j.expectations->>'temporaryFundingLamports','0')::numeric,0) ELSE 0 END),0)::text AS operating,coalesce(max(j.finalized_slot),0)::text AS slot FROM wallet_jobs j JOIN coins USING(network_genesis,mint))SELECT * FROM liabilities CROSS JOIN operations`,
        [network, collector, ['prepared', 'signed', 'submitted', 'manual_review']]
      )
    ).rows[0]!;
    return {
      liability: BigInt(row.liability),
      operating: BigInt(row.operating),
      minimumSlot: Number(row.slot),
    };
  }
  async tokenCustodyRequirement(network: string, collector: string, assetMint: string) {
    if (assetMint === HSOL_REWARD_MINT) {
      const { rows } = await this.db.query<{ liability: string; slot: string }>(
        `WITH coins AS (
           SELECT c.network_genesis,c.mint FROM launch_coins c
           JOIN launch_configs cfg USING(network_genesis,config_key)
           WHERE c.network_genesis=$1 AND cfg.expected_fee_claimer=$2
             AND c.policy_version IN('hsol-v1','cashback-hsol-v1','mskd-hsol-v1') AND cfg.policy_version=c.policy_version
             AND c.quote_mint=$3 AND cfg.quote_mint=$3
         )
         SELECT (SELECT coalesce(sum(b.funded-b.spent),0)::text FROM wallet_balances b JOIN coins USING(network_genesis,mint)) AS liability,
                (SELECT coalesce(max(j.finalized_slot),0)::text FROM wallet_jobs j JOIN coins USING(network_genesis,mint)) AS slot`,
        [network, collector, assetMint]
      );
      return { liability: BigInt(rows[0]!.liability), minimumSlot: Number(rows[0]!.slot) };
    }
    return mskdTokenLiability(this.db, network, collector, assetMint);
  }
  async job(id: string): Promise<WalletJob | null> {
    return (
      (await this.db.query<WalletJob>('SELECT * FROM wallet_jobs WHERE id=$1', [id])).rows[0] ??
      null
    );
  }
  private async operatingCapacity(
    client: Pick<PoolClient, 'query'>,
    network: string,
    collector: string
  ) {
    const row = (
      await client.query<{ available: string; reserved: string; debt: string }>(
        `WITH coins AS(SELECT c.network_genesis,c.mint FROM launch_coins c JOIN launch_configs cfg USING(network_genesis,config_key)
       WHERE c.network_genesis=$1 AND c.policy_version='bond-v1' AND cfg.policy_version='bond-v1' AND cfg.expected_fee_claimer=$2),
       funds AS(SELECT coalesce(sum(b.funded-b.spent-b.reserved),0)::text AS available FROM wallet_balances b JOIN coins USING(network_genesis,mint) WHERE b.bucket='platform'),
       costs AS(SELECT coalesce(sum(coalesce(j.expectations->>'operatingCostLamports','0')::numeric),0)::text AS reserved FROM wallet_jobs j JOIN coins USING(network_genesis,mint) WHERE j.status IN('prepared','signed','submitted','manual_review'))
       , debts AS(SELECT coalesce(sum(o.lamports-coalesce((SELECT sum(s.lamports) FROM wallet_operating_sources s WHERE s.job_id=o.job_id),0)),0)::text AS debt
        FROM wallet_operating_costs o JOIN wallet_jobs j ON j.id=o.job_id JOIN coins USING(network_genesis,mint))
       SELECT * FROM funds CROSS JOIN costs CROSS JOIN debts`,
        [network, collector]
      )
    ).rows[0]!;
    return {
      available: BigInt(row.available),
      reserved: BigInt(row.reserved),
      debt: BigInt(row.debt),
    };
  }
  /** Only actual platform income, or an exact DBC collection's forthcoming share, funds operations. */
  async collectionAffordable(
    network: string,
    mint: string,
    pool: string,
    net: bigint,
    cost: bigint
  ) {
    const coin = await this.coin(this.db, network, mint);
    if (coin.policy_version !== 'bond-v1') return true;
    const funds = await this.operatingCapacity(this.db, network, coin.collector);
    const incoming =
      pool === coin.dbc_pool
        ? (net * BigInt(10_000 - bondPolicy.preBondBuybackNetBps)) / 10_000n
        : 0n;
    return funds.available + incoming >= funds.reserved + funds.debt + cost;
  }
  async assertOperatingFunding(job: WalletJob) {
    const coin = await this.coin(this.db, job.network_genesis, job.mint);
    if (coin.policy_version !== 'bond-v1') return;
    const funds = await this.operatingCapacity(this.db, job.network_genesis, coin.collector);
    const incoming =
      job.kind === 'collect' && job.details.route === 'dbc'
        ? (BigInt(String(job.expectations.expectedLamports)) *
            BigInt(10_000 - bondPolicy.preBondBuybackNetBps)) /
          10_000n
        : 0n;
    if (funds.available + incoming < funds.reserved + funds.debt)
      throw new WalletOperatingUnavailable();
  }
  private async recordOperatingCost(
    client: PoolClient,
    coin: WalletCoin,
    job: WalletJob,
    cost: bigint
  ) {
    if (coin.policy_version !== 'bond-v1') return;
    if (cost < 0n || cost > BigInt(String(job.expectations.operatingCostLamports)))
      throw new Error('Finalized operating cost exceeds the approved bound');
    const prior = (
      await client.query<{ signature: string; lamports: string }>(
        'SELECT signature,lamports::text FROM wallet_operating_costs WHERE job_id=$1',
        [job.id]
      )
    ).rows[0];
    if (prior) {
      if (prior.signature !== job.signature || BigInt(prior.lamports) !== cost)
        throw new Error('Conflicting operating expense receipt');
      return;
    }
    const balances = (
      await client.query<{ mint: string; available: string }>(
        `SELECT b.mint,(b.funded-b.reserved-b.spent)::text AS available FROM wallet_balances b
       JOIN launch_coins c USING(network_genesis,mint) JOIN launch_configs cfg USING(network_genesis,config_key)
       WHERE b.network_genesis=$1 AND b.bucket='platform' AND c.policy_version='bond-v1' AND cfg.policy_version='bond-v1'
       AND cfg.expected_fee_claimer=$2 AND b.funded>b.reserved+b.spent
       ORDER BY CASE WHEN b.mint=$3 THEN 0 ELSE 1 END,b.mint FOR UPDATE OF b`,
        [job.network_genesis, coin.collector, job.mint]
      )
    ).rows;
    await client.query(
      'INSERT INTO wallet_operating_costs(job_id,signature,lamports)VALUES($1,$2,$3)',
      [job.id, job.signature, cost.toString()]
    );
    const debts = (
      await client.query<{ job_id: string; remaining: string }>(
        `SELECT o.job_id,(o.lamports-coalesce((SELECT sum(s.lamports) FROM wallet_operating_sources s WHERE s.job_id=o.job_id),0))::text AS remaining
       FROM wallet_operating_costs o JOIN wallet_jobs j ON j.id=o.job_id
       JOIN launch_coins c USING(network_genesis,mint) JOIN launch_configs cfg USING(network_genesis,config_key)
       WHERE j.network_genesis=$1 AND cfg.expected_fee_claimer=$2
       AND o.lamports>coalesce((SELECT sum(s.lamports) FROM wallet_operating_sources s WHERE s.job_id=o.job_id),0)
       ORDER BY j.created_at,j.id`,
        [job.network_genesis, coin.collector]
      )
    ).rows;
    for (const debt of debts) {
      let remaining = BigInt(debt.remaining);
      for (const balance of balances) {
        const debit = BigInt(balance.available) < remaining ? BigInt(balance.available) : remaining;
        if (debit === 0n) continue;
        await client.query(
          "UPDATE wallet_balances SET spent=spent+$3 WHERE network_genesis=$1 AND mint=$2 AND bucket='platform'",
          [job.network_genesis, balance.mint, debit.toString()]
        );
        await client.query(
          'INSERT INTO wallet_operating_sources(id,job_id,network_genesis,mint,lamports)VALUES($1,$2,$3,$4,$5)',
          [randomUUID(), debt.job_id, job.network_genesis, balance.mint, debit.toString()]
        );
        remaining -= debit;
        balance.available = (BigInt(balance.available) - debit).toString();
      }
    }
  }
  async assertNoUnsettledSigned(
    network: string,
    collector: string,
    jobId: string,
    query: Pick<PoolClient, 'query'> = this.db
  ): Promise<void> {
    const row = (
      await query.query<{ count: string }>(
        `SELECT count(*)::text FROM wallet_jobs j JOIN launch_coins c USING(network_genesis,mint)JOIN launch_configs cfg ON(cfg.network_genesis=c.network_genesis AND cfg.config_key=c.config_key)WHERE j.network_genesis=$1 AND cfg.expected_fee_claimer=$2 AND c.policy_version IN('wallet-v1','bond-v1','dev-v1','cashback-v1','mskd-v1','hsol-v1','cashback-hsol-v1','mskd-hsol-v1','masked-v1') AND j.id<>$3 AND j.signature IS NOT NULL AND j.status IN('signed','submitted','manual_review')`,
        [network, collector, jobId]
      )
    ).rows[0]!;
    if (BigInt(row.count) !== 0n)
      throw new Error('Reconcile the existing signed collector attempt before another signature');
  }
  async health(network: string, collector: string) {
    const activeJobs = (
      await this.db.query<{
        id: string;
        mint: string;
        kind: string;
        status: string;
        signature: string | null;
        last_valid_block_height: string | null;
      }>(
        `SELECT j.id,j.mint,j.kind,j.status,j.signature,j.last_valid_block_height::text FROM wallet_jobs j JOIN launch_coins c USING(network_genesis,mint)JOIN launch_configs cfg ON(cfg.network_genesis=c.network_genesis AND cfg.config_key=c.config_key)WHERE j.network_genesis=$1 AND cfg.expected_fee_claimer=$2 AND c.policy_version IN('wallet-v1','bond-v1','dev-v1','cashback-v1','mskd-v1','hsol-v1','cashback-hsol-v1','mskd-hsol-v1','masked-v1') AND j.status=ANY($3::text[])ORDER BY j.created_at,j.id LIMIT 100`,
        [network, collector, ACTIVE]
      )
    ).rows;
    const jobs = (
      await this.db.query<{ kind: string; status: string; count: string }>(
        `SELECT j.kind,j.status,count(*)::text FROM wallet_jobs j JOIN launch_coins c USING(network_genesis,mint)JOIN launch_configs cfg ON(cfg.network_genesis=c.network_genesis AND cfg.config_key=c.config_key)WHERE j.network_genesis=$1 AND c.policy_version IN('wallet-v1','bond-v1','dev-v1','cashback-v1','mskd-v1','hsol-v1','cashback-hsol-v1','mskd-hsol-v1','masked-v1') AND cfg.expected_fee_claimer=$2 GROUP BY j.kind,j.status ORDER BY j.kind,j.status`,
        [network, collector]
      )
    ).rows;
    const cursors = (
      await this.db.query<{
        mint: string;
        pool: string;
        complete: boolean | null;
        finalized_slot: string | null;
        scan_head_signature: string | null;
        missing_count: string;
        total_count: string;
      }>(
        `WITH coins AS(SELECT c.* FROM launch_coins c JOIN launch_configs cfg ON(cfg.network_genesis=c.network_genesis AND cfg.config_key=c.config_key)WHERE c.network_genesis=$1 AND c.policy_version IN('wallet-v1','bond-v1','dev-v1','cashback-v1','mskd-v1','hsol-v1','cashback-hsol-v1','mskd-hsol-v1','masked-v1') AND cfg.expected_fee_claimer=$2),pools AS(SELECT mint,dbc_pool AS pool FROM coins UNION ALL SELECT c.mint,m.damm_pool AS pool FROM coins c JOIN launch_migrations m USING(network_genesis,mint))SELECT p.mint,p.pool,i.complete,i.finalized_slot::text,i.scan_head_signature,count(*)FILTER(WHERE i.complete IS DISTINCT FROM true OR i.scan_head_signature IS NOT NULL)OVER()::text AS missing_count,count(*)OVER()::text AS total_count FROM pools p LEFT JOIN wallet_index_cursors i ON(i.network_genesis=$1 AND i.pool=p.pool)ORDER BY p.mint,p.pool LIMIT 100`,
        [network, collector]
      )
    ).rows;
    return {
      jobs,
      activeJobs,
      cursors,
      missingOrPartialCursors: Number(cursors[0]?.missing_count ?? 0),
      totalPools: Number(cursors[0]?.total_count ?? 0),
      custody: await this.custodyRequirement(network, collector),
    };
  }
  async pendingJobs(network: string, mint: string, limit = 20): Promise<WalletJob[]> {
    return (
      await this.db.query<WalletJob>(
        `SELECT * FROM wallet_jobs WHERE network_genesis=$1 AND mint=$2 AND status=ANY($3::text[]) ORDER BY created_at,id LIMIT $4`,
        [network, mint, ACTIVE, Math.max(1, Math.min(limit, 100))]
      )
    ).rows;
  }
  async executionCandidates(network: string, collector: string, limit: number, mint?: string) {
    return (
      await this.db.query<{ id: string }>(
        `SELECT j.id FROM wallet_jobs j JOIN launch_coins c USING(network_genesis,mint)
        JOIN launch_configs cfg USING(network_genesis,config_key)
        WHERE j.network_genesis=$1 AND cfg.expected_fee_claimer=$2
        AND c.policy_version=cfg.policy_version
        AND (j.status IN ('prepared','signed','submitted','manual_review')
          OR (j.status='queued' AND j.kind IN ('creator_claim','community_claim','wxmr_claim')))
        AND ($4::text IS NULL OR j.mint=$4 OR j.signature IS NOT NULL)
        ORDER BY (j.signature IS NOT NULL) DESC,
          CASE WHEN j.kind IN ('creator_claim','community_claim','wxmr_claim') THEN 0
               WHEN j.kind='platform_claim' THEN 2 ELSE 1 END,
          j.created_at,j.id LIMIT $3`,
        [network, collector, limit, mint ?? null]
      )
    ).rows;
  }
  async oldestUserClaimSeconds(network: string, collector: string) {
    const row = (
      await this.db.query<{ age: number }>(
        `SELECT coalesce(extract(epoch FROM now()-min(j.created_at)),0)::int AS age
        FROM wallet_jobs j JOIN launch_coins c USING(network_genesis,mint)
        JOIN launch_configs cfg USING(network_genesis,config_key)
        WHERE j.network_genesis=$1 AND cfg.expected_fee_claimer=$2
        AND c.policy_version=cfg.policy_version
        AND j.kind IN ('creator_claim','community_claim','wxmr_claim') AND j.status=ANY($3::text[])`,
        [network, collector, ACTIVE]
      )
    ).rows[0]!;
    return row.age;
  }
  async payoutForRequest(
    network: string,
    mint: string,
    wallet: string,
    requestId: string
  ): Promise<WalletJob | null> {
    return (
      (
        await this.db.query<WalletJob>(
          `SELECT j.* FROM wallet_claim_requests r JOIN wallet_jobs j ON j.id=r.job_id WHERE r.network_genesis=$1 AND r.mint=$2 AND r.wallet=$3 AND r.request_id=$4`,
          [network, mint, wallet, requestId]
        )
      ).rows[0] ?? null
    );
  }
  async requestClaim(input: {
    networkGenesis: string;
    mint: string;
    wallet: string;
    epoch: number | null;
    amount: bigint;
    requestId: string;
    authorizationDigest: string;
    assetMint?: string;
  }): Promise<WalletJob> {
    const { networkGenesis: network, mint, wallet, epoch, requestId, authorizationDigest } = input;
    amount(input.amount);
    publicKey(wallet);
    if (
      !/^[a-f0-9]{64}$/.test(authorizationDigest) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId) ||
      (epoch !== null && (!Number.isSafeInteger(epoch) || epoch < 0))
    )
      throw new Error('Invalid authenticated claim intent');
    return this.tx(async (client) => {
      await this.lock(client, network, mint);
      const coin = await this.coin(client, network, mint);
      // Masked creator and holder shares are claimed through the XMR/SOL claim screen, not here.
      if (isMaskedMode(coin.mode)) throw new Error('Masked claims use the claim screen');
      const batched = hasBatchedHolderRewards(coin.mode);
      const assetMint = signedRewardMint(coin.mode, network);
      if (assetMint === null || input.assetMint !== assetMint)
        throw new Error('Claim asset differs from the funded payout policy');
      const existing = (
        await client.query<{
          mint: string;
          wallet: string;
          epoch: string | null;
          lamports: string;
          authorization_digest: string;
          job_id: string;
        }>(`SELECT * FROM wallet_claim_requests WHERE network_genesis=$1 AND request_id=$2`, [
          network,
          requestId,
        ])
      ).rows[0];
      if (existing) {
        if (
          existing.mint !== mint ||
          existing.wallet !== wallet ||
          (existing.epoch === null ? null : String(existing.epoch)) !==
            (epoch === null ? null : String(epoch)) ||
          BigInt(existing.lamports) !== input.amount ||
          existing.authorization_digest !== authorizationDigest
        )
          throw new Error('Claim request conflicts with its immutable authorization');
        return (
          await client.query<WalletJob>('SELECT * FROM wallet_jobs WHERE id=$1', [existing.job_id])
        ).rows[0]!;
      }
      const creator = hasCreatorRewards(coin.mode);
      const kind = creator ? 'creator_claim' : 'community_claim';
      if (
        (creator && (wallet !== coin.original_deployer || epoch !== null)) ||
        (!creator && epoch === null)
      )
        throw new Error('Claim recipient/epoch differs from the immutable coin mode');
      if (isCashbackMode(coin.mode) && input.amount < MINIMUM_HOLDER_PAYOUT_LAMPORTS)
        throw new Error('Earn at least 0.001 quote tokens before requesting a Cashback payout');
      const bucket = creator ? 'creator' : 'community',
        balance = await this.balance(client, network, mint, bucket);
      if (!creator && !batched) {
        const entitlement = (
          await client.query<{ lamports: string }>(
            'SELECT lamports::text FROM wallet_allocations WHERE network_genesis=$1 AND mint=$2 AND epoch=$3 AND wallet=$4',
            [network, mint, epoch, wallet]
          )
        ).rows[0];
        if (
          !entitlement ||
          BigInt(entitlement.lamports) !== input.amount ||
          BigInt(balance.reserved) < input.amount
        )
          throw new Error('Exact funded holder entitlement is required');
        if (
          (
            await client.query(
              "SELECT id FROM wallet_jobs WHERE network_genesis=$1 AND mint=$2 AND recipient=$3 AND epoch=$4 AND kind='community_claim' AND status='finalized'",
              [network, mint, wallet, epoch]
            )
          ).rows.length
        )
          throw new Error('Holder entitlement was already paid');
      }
      const pending = (
        await client.query<WalletJob>(
          `SELECT * FROM wallet_jobs WHERE network_genesis=$1 AND mint=$2 AND recipient=$3 AND kind IN('creator_claim','community_claim') AND status=ANY($4::text[]) FOR UPDATE`,
          [network, mint, wallet, ACTIVE]
        )
      ).rows[0];
      let job: WalletJob;
      if (pending) {
        if (
          pending.kind !== kind ||
          (pending.epoch === null ? null : String(pending.epoch)) !==
            (epoch === null ? null : String(epoch)) ||
          BigInt(pending.lamports) !== input.amount
        )
          throw new Error('An existing payout must finish before another claim');
        job = pending;
      } else {
        if (creator) {
          if (
            BigInt(balance.funded) - BigInt(balance.reserved) - BigInt(balance.spent) <
            input.amount
          )
            throw new Error('Claim exceeds collected available income');
          await client.query(
            "UPDATE wallet_balances SET reserved=reserved+$3 WHERE network_genesis=$1 AND mint=$2 AND bucket='creator'",
            [network, mint, input.amount.toString()]
          );
        }
        job = (
          await client.query<WalletJob>(
            `INSERT INTO wallet_jobs(id,network_genesis,mint,kind,intent_key,bucket,recipient,epoch,lamports,details)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)RETURNING *`,
            [
              randomUUID(),
              network,
              mint,
              kind,
              `claim:${requestId}`,
              bucket,
              wallet,
              epoch,
              input.amount.toString(),
              JSON.stringify({
                collector: coin.collector,
                treasury: coin.treasury,
                ...(assetMint ? { assetMint } : {}),
              }),
            ]
          )
        ).rows[0]!;
        if (batched && assetMint) {
          if (isCashbackMode(coin.mode) && BigInt(balance.reserved) < input.amount)
            throw new Error('Exact funded holder entitlement is required');
          await attachHolderAllocations(
            client,
            input,
            assetMint,
            epoch!,
            job.id,
            input.amount,
            MINIMUM_HOLDER_PAYOUT_LAMPORTS
          );
        }
      }
      await client.query(
        `INSERT INTO wallet_claim_requests(network_genesis,request_id,mint,wallet,epoch,lamports,authorization_digest,job_id)VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          network,
          requestId,
          mint,
          wallet,
          epoch,
          input.amount.toString(),
          authorizationDigest,
          job.id,
        ]
      );
      return job;
    });
  }
  async rewardsView(input: {
    networkGenesis: string;
    mint: string;
    wallet: string;
    beforeEpoch?: number;
    limit?: number;
  }): Promise<WalletRewardsView> {
    const { networkGenesis: network, mint, wallet } = input,
      coin = await this.coin(this.db, network, mint, true),
      limit = Math.max(1, Math.min(input.limit ?? 10, 100));
    const pending =
      (
        await this.db.query<WalletJob>(
          `SELECT * FROM wallet_jobs WHERE network_genesis=$1 AND mint=$2 AND recipient=$3 AND kind IN('creator_claim','community_claim') AND status=ANY($4::text[]) ORDER BY created_at,id LIMIT 1`,
          [network, mint, wallet, ACTIVE]
        )
      ).rows[0] ?? null;
    const receipts = (
      await this.db.query<{
        id: string;
        lamports: string;
        signature: string;
        finalizedSlot: string;
      }>(
        `SELECT id,lamports::text,signature,finalized_slot::text AS "finalizedSlot" FROM wallet_jobs WHERE network_genesis=$1 AND mint=$2 AND recipient=$3 AND kind IN('creator_claim','community_claim') AND status='finalized' AND signature IS NOT NULL AND finalized_slot IS NOT NULL ORDER BY finalized_slot DESC,id DESC LIMIT 10`,
        [network, mint, wallet]
      )
    ).rows;
    const paid = BigInt(
      (
        await this.db.query<{ paid: string }>(
          `SELECT coalesce(sum(lamports),0)::text AS paid FROM wallet_jobs WHERE network_genesis=$1 AND mint=$2 AND recipient=$3 AND kind IN('creator_claim','community_claim') AND status='finalized'`,
          [network, mint, wallet]
        )
      ).rows[0]!.paid
    );
    if (hasCreatorRewards(coin.mode)) {
      const balance = (await this.balanceRows(network, mint)).find(
        (row) => row.bucket === 'creator'
      );
      return {
        mode: coin.mode,
        availableLamports: wallet === coin.original_deployer ? (balance?.available ?? '0') : '0',
        paidLamports: paid.toString(),
        epochs: [],
        pendingPayout: pending,
        receipts,
      };
    }
    const batched = hasBatchedHolderRewards(coin.mode);
    const holderJobJoin = batched
      ? batchedHolderJobJoin
      : `LEFT JOIN wallet_jobs j ON(j.network_genesis=a.network_genesis AND j.mint=a.mint AND j.epoch=a.epoch AND j.recipient=a.wallet AND j.kind='community_claim' AND j.status<>'failed')`;
    const conversionJoin = isMskdMode(coin.mode)
      ? `JOIN wallet_mskd_snapshots s USING(network_genesis,mint,epoch)
       JOIN wallet_mskd_conversions conversion ON conversion.job_id=s.job_id`
      : '';
    const epochs = (
      await this.db.query<{
        epoch: string;
        lamports: string;
        snapshot_slot: string;
        snapshot_digest: string;
        status: 'available' | 'queued' | 'paid';
        jobId: string | null;
        signature: string | null;
        conversion_signature?: string;
      }>(
        `SELECT a.epoch::text,a.lamports::text,e.snapshot_slot::text,e.snapshot_digest,${isMskdMode(coin.mode) ? 'conversion.signature AS conversion_signature,' : ''}
   CASE WHEN j.status='finalized' THEN 'paid' WHEN j.id IS NOT NULL THEN 'queued' ELSE 'available' END AS status,j.id AS "jobId",CASE WHEN j.status='finalized' THEN j.signature ELSE NULL END AS signature FROM wallet_allocations a JOIN wallet_epochs e USING(network_genesis,mint,epoch)
   ${conversionJoin}
   ${holderJobJoin}
   WHERE a.network_genesis=$1 AND a.mint=$2 AND a.wallet=$3 AND($4::bigint IS NULL OR a.epoch<$4) ORDER BY a.epoch DESC LIMIT $5`,
        [network, mint, wallet, input.beforeEpoch ?? null, limit]
      )
    ).rows;
    const assetMint = signedRewardMint(coin.mode, network);
    const claim = batched && assetMint ? await holderClaimTotal(this.db, input, assetMint) : null;
    return {
      mode: coin.mode,
      availableLamports:
        claim?.amount ??
        epochs
          .filter((row) => row.status === 'available')
          .reduce((sum, row) => sum + BigInt(row.lamports), 0n)
          .toString(),
      paidLamports: paid.toString(),
      ...(claim && assetMint
        ? {
            holderClaim:
              claim.throughEpoch &&
              BigInt(claim.source) >= MINIMUM_HOLDER_PAYOUT_LAMPORTS &&
              BigInt(claim.amount) <= 18446744073709551615n
                ? { amount: claim.amount, throughEpoch: claim.throughEpoch, assetMint }
                : null,
          }
        : {}),
      epochs,
      pendingPayout: pending,
      receipts,
    };
  }
  async epoch(network: string, mint: string, epoch: number): Promise<WalletEpoch | null> {
    return (
      (
        await this.db.query<WalletEpoch>(
          'SELECT * FROM wallet_epochs WHERE network_genesis=$1 AND mint=$2 AND epoch=$3',
          [network, mint, epoch]
        )
      ).rows[0] ?? null
    );
  }
  private async holderBudget(client: PoolClient, network: string, mint: string, slot: number) {
    const balance = await this.balance(client, network, mint, 'community');
    const collected = (
      await client.query<{ funded: string }>(
        `SELECT coalesce(sum(community),0)::text AS funded FROM wallet_collections
       WHERE network_genesis=$1 AND mint=$2 AND finalized_slot<=$3`,
        [network, mint, slot]
      )
    ).rows[0]!;
    const funded =
      BigInt(collected.funded) < BigInt(balance.funded)
        ? BigInt(collected.funded)
        : BigInt(balance.funded);
    return funded - BigInt(balance.spent) - BigInt(balance.reserved);
  }
  async queueMskdConversion(snapshot: FinalizedHolderSnapshot) {
    const { networkGenesis: network, mint } = snapshot;
    assertHolderSnapshot(snapshot, network, mint);
    const epoch = Math.floor(snapshot.blockTime / 3600) - 1;
    if (epoch < 0 || snapshot.blockTime % 3600 >= 60)
      throw new Error('MSKD conversion requires a finalized hourly snapshot');
    const asset = mskdPayoutMint(network);
    const market = mskdConversionPool();
    if (!asset || !market) return null;
    const assetMint = asset.toBase58();
    return this.tx(async (client) => {
      await this.lock(client, network, mint);
      const coin = await this.coin(client, network, mint);
      if (
        !isMskdMode(coin.mode) ||
        ![coin.collector, coin.treasury].every((owner) => snapshot.excluded.has(owner))
      )
        throw new Error('MSKD conversion requires the registered holder and company wallet policy');
      const latest = (
        await client.query<{ epoch: string; payout_mint: string }>(
          `SELECT epoch,payout_mint FROM wallet_mskd_snapshots WHERE network_genesis=$1 AND mint=$2 ORDER BY epoch DESC LIMIT 1`,
          [network, mint]
        )
      ).rows[0];
      if (latest && latest.payout_mint !== assetMint)
        throw new Error('The funded MSKD payout mint is immutable');
      if (latest && Number(latest.epoch) >= epoch) return null;
      const available = await this.holderBudget(client, network, mint, snapshot.slot);
      if (available < MINIMUM_HOLDER_PAYOUT_LAMPORTS) return null;
      const budget =
        available < MAXIMUM_MSKD_CONVERSION_LAMPORTS ? available : MAXIMUM_MSKD_CONVERSION_LAMPORTS;
      return insertMskdConversion(
        client,
        snapshot,
        {
          assetMint,
          market: market.toBase58(),
          ...(isHsolMode(coin.mode) ? { sourceMint: HSOL_REWARD_MINT } : {}),
          collector: coin.collector,
          treasury: coin.treasury,
        },
        epoch,
        budget
      );
    });
  }
  async createEpoch(input: {
    networkGenesis: string;
    mint: string;
    epoch: number;
    snapshot: FinalizedHolderSnapshot;
  }): Promise<WalletEpoch> {
    const { networkGenesis: network, mint, epoch, snapshot } = input;
    assertHolderSnapshot(snapshot, network, mint);
    if (
      !Number.isSafeInteger(epoch) ||
      epoch !== Math.floor(snapshot.blockTime / 3600) - 1 ||
      epoch < 0
    )
      throw new Error('A real finalized snapshot for the current processing hour is required');
    return this.tx(async (client) => {
      await this.lock(client, network, mint);
      const coin = await this.coin(client, network, mint);
      const cashback = isCashbackMode(coin.mode);
      if (coin.mode !== 'community' && !cashback)
        throw new Error('Launch mode does not allocate SOL holder income');
      if (
        cashback &&
        (snapshot.blockTime % 3600 >= 60 ||
          ![coin.collector, coin.treasury].every((owner) => snapshot.excluded.has(owner)))
      )
        throw new Error(
          'Cashback requires a finalized hourly snapshot with company wallet exclusions'
        );
      const prior = (
        await client.query<WalletEpoch>(
          'SELECT * FROM wallet_epochs WHERE network_genesis=$1 AND mint=$2 AND epoch=$3',
          [network, mint, epoch]
        )
      ).rows[0];
      if (prior) return prior;
      const budget = await this.holderBudget(client, network, mint, snapshot.slot);
      if (budget <= 0n)
        throw new Error('No collected income is available at the actual snapshot bank');
      const allocation = allocateHolderSnapshot(budget, snapshot),
        allocated = budget - allocation.carryForward;
      const saved = (
        await client.query<WalletEpoch>(
          coin.mode === 'cashback-hsol'
            ? `INSERT INTO wallet_epochs(network_genesis,mint,epoch,snapshot_slot,snapshot_time,snapshot_digest,budget,allocated,carry,snapshot_exclusions,asset_mint)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)RETURNING *`
            : cashback
              ? `INSERT INTO wallet_epochs(network_genesis,mint,epoch,snapshot_slot,snapshot_time,snapshot_digest,budget,allocated,carry,snapshot_exclusions)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)RETURNING *`
              : `INSERT INTO wallet_epochs(network_genesis,mint,epoch,snapshot_slot,snapshot_time,snapshot_digest,budget,allocated,carry)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)RETURNING *`,
          [
            network,
            mint,
            epoch,
            snapshot.slot,
            snapshot.blockTime,
            snapshot.digest,
            budget.toString(),
            allocated.toString(),
            allocation.carryForward.toString(),
            ...(cashback ? [JSON.stringify([...snapshot.excluded].sort())] : []),
            ...(coin.mode === 'cashback-hsol' ? [HSOL_REWARD_MINT] : []),
          ]
        )
      ).rows[0]!;
      if (allocation.allocations.length)
        await client.query(
          `INSERT INTO wallet_allocations(network_genesis,mint,epoch,wallet,lamports)
    SELECT $1,$2,$3,holder.wallet,holder.lamports::numeric FROM jsonb_to_recordset($4::jsonb)AS holder(wallet text,lamports text)`,
          [
            network,
            mint,
            epoch,
            JSON.stringify(
              allocation.allocations.map((row) => ({
                wallet: row.wallet,
                lamports: row.lamports.toString(),
              }))
            ),
          ]
        );
      await client.query(
        "UPDATE wallet_balances SET reserved=reserved+$3 WHERE network_genesis=$1 AND mint=$2 AND bucket='community'",
        [network, mint, allocated.toString()]
      );
      return saved;
    });
  }
  /** Stores one verified finalized holder snapshot as the sample for its five-minute window. */
  async recordMaskedSample(snapshot: FinalizedHolderSnapshot) {
    const { networkGenesis: network, mint } = snapshot;
    assertHolderSnapshot(snapshot, network, mint);
    const coin = await this.coin(this.db, network, mint);
    if (!isMaskedMode(coin.mode)) throw new Error('Only Masked coins use time-weighted samples');
    if (!snapshot.excluded.has(coin.collector) || !snapshot.excluded.has(coin.treasury))
      throw new Error('Holder samples must exclude the company wallets');
    const inserted = await this.db.query(
      `INSERT INTO masked_holder_samples(network_genesis,mint,sample_window,slot,block_time,digest,supply,balances,excluded)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING sample_window`,
      [
        network,
        mint,
        Math.floor(snapshot.blockTime / MASKED_SAMPLE_SECONDS),
        snapshot.slot,
        snapshot.blockTime,
        snapshot.digest,
        snapshot.supply.toString(),
        JSON.stringify(snapshot.balances.map((row) => [row.wallet, row.tokens.toString()])),
        JSON.stringify([...snapshot.excluded].sort()),
      ]
    );
    return inserted.rows.length > 0;
  }

  async hasMaskedSample(network: string, mint: string, window: number) {
    return (
      (
        await this.db.query(
          'SELECT 1 FROM masked_holder_samples WHERE network_genesis=$1 AND mint=$2 AND sample_window=$3',
          [network, mint, window]
        )
      ).rows.length > 0
    );
  }

  /**
   * Allocates one completed hour of a Masked coin's holder income by time-weighted balances:
   * that hour's samples plus the closing sample taken in the first window of the next hour.
   * Too few samples leaves the income unallocated; it rolls into the next hour.
   */
  async createMaskedEpoch(network: string, mint: string, epoch: number) {
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('Invalid epoch');
    return this.tx(async (client) => {
      await this.lock(client, network, mint);
      const coin = await this.coin(client, network, mint);
      if (!isMaskedMode(coin.mode)) throw new Error('Only Masked coins use time-weighted epochs');
      const prior = (
        await client.query<WalletEpoch>(
          'SELECT * FROM wallet_epochs WHERE network_genesis=$1 AND mint=$2 AND epoch=$3',
          [network, mint, epoch]
        )
      ).rows[0];
      if (prior) return { status: 'existing' as const, epoch: prior };
      const first = (epoch * 3600) / MASKED_SAMPLE_SECONDS,
        closing = ((epoch + 1) * 3600) / MASKED_SAMPLE_SECONDS;
      const rows = (
        await client.query<{
          sample_window: string;
          slot: string;
          block_time: string;
          digest: string;
          balances: [string, string][];
          excluded: string[];
        }>(
          `SELECT sample_window::text,slot::text,block_time::text,digest,balances,excluded FROM masked_holder_samples
           WHERE network_genesis=$1 AND mint=$2 AND sample_window BETWEEN $3 AND $4 ORDER BY sample_window`,
          [network, mint, first, closing]
        )
      ).rows;
      const close = rows.find((row) => Number(row.sample_window) === closing);
      const hourSamples = rows.filter((row) => Number(row.sample_window) < closing);
      if (!close || hourSamples.length < MASKED_MINIMUM_SAMPLES)
        return { status: 'insufficient_samples' as const, samples: hourSamples.length };
      const used = [...hourSamples, close];
      const snapshot = timeWeightedBalances(
        used.map((row) => ({
          balances: row.balances.map(([wallet, tokens]) => ({ wallet, tokens: BigInt(tokens) })),
          excluded: new Set(row.excluded),
        }))
      );
      const budget = await this.holderBudget(client, network, mint, Number(close.slot));
      if (budget <= 0n) return { status: 'no_income' as const };
      const allocation = allocateHolderSnapshot(budget, snapshot),
        allocated = budget - allocation.carryForward;
      const digest = createHash('sha256')
        .update(JSON.stringify(['masked-time-weighted-v1', ...used.map((row) => row.digest)]))
        .digest('hex');
      const saved = (
        await client.query<WalletEpoch>(
          `INSERT INTO wallet_epochs(network_genesis,mint,epoch,snapshot_slot,snapshot_time,snapshot_digest,budget,allocated,carry,snapshot_exclusions,sample_count)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [
            network,
            mint,
            epoch,
            close.slot,
            close.block_time,
            digest,
            budget.toString(),
            allocated.toString(),
            allocation.carryForward.toString(),
            JSON.stringify([...snapshot.excluded].sort()),
            used.length,
          ]
        )
      ).rows[0]!;
      if (allocation.allocations.length)
        await client.query(
          `INSERT INTO wallet_allocations(network_genesis,mint,epoch,wallet,lamports)
           SELECT $1,$2,$3,holder.wallet,holder.lamports::numeric FROM jsonb_to_recordset($4::jsonb)AS holder(wallet text,lamports text)`,
          [
            network,
            mint,
            epoch,
            JSON.stringify(
              allocation.allocations.map((row) => ({
                wallet: row.wallet,
                lamports: row.lamports.toString(),
              }))
            ),
          ]
        );
      await client.query(
        "UPDATE wallet_balances SET reserved=reserved+$3 WHERE network_genesis=$1 AND mint=$2 AND bucket='community'",
        [network, mint, allocated.toString()]
      );
      // The closing sample opens the next hour; earlier samples are committed to by the digest.
      await client.query(
        'DELETE FROM masked_holder_samples WHERE network_genesis=$1 AND mint=$2 AND sample_window<$3',
        [network, mint, closing]
      );
      return { status: 'created' as const, epoch: saved };
    });
  }

  /** Queues the next wXMR payment for each open Masked wXMR claim paid by this collector. */
  async queueMaskedWxmrPayments(input: {
    network: string;
    collector: string;
    assetMint: string;
    market: string;
    alert?: (alert: WxmrAlert) => void;
  }) {
    return this.tx(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `wallet-operating:${input.network}`,
      ]);
      return queueWxmrPayments(client, input);
    });
  }

  /**
   * Moves a Masked coin's accrued $MSKD buyback share to the official $MSKD coin's buyback budget,
   * where the existing buyback job buys and burns $MSKD. Only between coins that share the
   * company collector, since no SOL moves. Returns the lamports moved.
   */
  async transferMskdBuyback(network: string, sourceMint: string, targetMint: string) {
    if (sourceMint === targetMint) throw new Error('$MSKD buys back with other coins’ income');
    return this.tx(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `wallet-operating:${network}`,
      ]);
      for (const mint of [sourceMint, targetMint].sort())
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `wallet-settlement:${network}:${mint}`,
        ]);
      const source = await this.coin(client, network, sourceMint),
        target = await this.coin(client, network, targetMint);
      if (!isMaskedMode(source.mode)) throw new Error('Only Masked coins fund $MSKD buybacks');
      if (source.collector !== target.collector)
        throw new Error('$MSKD and this coin use different collector wallets');
      const balance = await this.balance(client, network, sourceMint, 'mskd_buyback');
      const available = BigInt(balance.funded) - BigInt(balance.reserved) - BigInt(balance.spent);
      if (available <= 0n) return 0n;
      await client.query(
        "UPDATE wallet_balances SET spent=spent+$3 WHERE network_genesis=$1 AND mint=$2 AND bucket='mskd_buyback'",
        [network, sourceMint, available.toString()]
      );
      await this.balance(client, network, targetMint, 'rinse_buyback');
      await client.query(
        "UPDATE wallet_balances SET funded=funded+$3 WHERE network_genesis=$1 AND mint=$2 AND bucket='rinse_buyback'",
        [network, targetMint, available.toString()]
      );
      await client.query(
        `INSERT INTO masked_mskd_buyback_transfers(id,network_genesis,source_mint,target_mint,lamports) VALUES($1,$2,$3,$4,$5)`,
        [randomUUID(), network, sourceMint, targetMint, available.toString()]
      );
      return available;
    });
  }

  async indexCursor(network: string, pool: string): Promise<FinancialIndexCursor> {
    await this.db.query(
      'INSERT INTO wallet_index_cursors(network_genesis,pool)VALUES($1,$2)ON CONFLICT DO NOTHING',
      [network, pool]
    );
    return (
      await this.db.query<FinancialIndexCursor>(
        'SELECT * FROM wallet_index_cursors WHERE network_genesis=$1 AND pool=$2',
        [network, pool]
      )
    ).rows[0]!;
  }
  async advanceIndexCursor(input: FinancialIndexCursor): Promise<FinancialIndexCursor> {
    const saved = (
      await this.db.query<FinancialIndexCursor>(
        `UPDATE wallet_index_cursors SET newest_signature=$3,oldest_signature=$4,complete=$5,scan_head_signature=$6,scan_before_signature=$7,scan_until_signature=$8,finalized_slot=$9,version=version+1,updated_at=now() WHERE network_genesis=$1 AND pool=$2 AND version=$10 RETURNING *`,
        [
          input.network_genesis,
          input.pool,
          input.newest_signature,
          input.oldest_signature,
          input.complete,
          input.scan_head_signature,
          input.scan_before_signature,
          input.scan_until_signature,
          input.finalized_slot,
          input.version,
        ]
      )
    ).rows[0];
    if (!saved) throw new Error('Another wallet index worker advanced this cursor');
    return saved;
  }
  async ingestFinalizedFees(events: VerifiedFeeEvent[]): Promise<number> {
    for (const event of events) {
      assertVerifiedFee(event);
      const coin = await this.coin(this.db, event.networkGenesis, event.mint);
      if (
        coin.policy_version === 'bond-v1' &&
        event.phase !== (event.pool === coin.dbc_pool ? 0 : 1)
      )
        throw new Error('Bond it. fee phase must match the executed pool');
      if (!(await verifiedFinancialPool(event.networkGenesis, event.mint, event.pool)))
        throw new Error('Unverified wallet fee pool');
    }
    return this.tx(async (client) => {
      let count = 0;
      for (const event of events) {
        const a = event.allocation,
          net = a.rinseBuyback + a.creator + a.community + a.platform + a.mskdBuyback;
        const inserted = await client.query(
          `INSERT INTO wallet_fee_events(network_genesis,mint,pool,signature,instruction_index,event_index,finalized_slot,trade_time,phase,total,protocol,referral,net,event_digest)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)ON CONFLICT DO NOTHING RETURNING event_digest`,
          [
            event.networkGenesis,
            event.mint,
            event.pool,
            event.signature,
            event.instructionIndex,
            event.eventIndex,
            event.finalizedSlot,
            event.tradeTime,
            event.phase,
            event.total.toString(),
            a.protocol.toString(),
            a.referral.toString(),
            net.toString(),
            event.eventDigest,
          ]
        );
        if (inserted.rows.length) count++;
        else {
          const prior = (
            await client.query<{ event_digest: string; mint: string; pool: string }>(
              'SELECT event_digest,mint,pool FROM wallet_fee_events WHERE network_genesis=$1 AND signature=$2 AND instruction_index=$3 AND event_index=$4',
              [event.networkGenesis, event.signature, event.instructionIndex, event.eventIndex]
            )
          ).rows[0];
          if (
            !prior ||
            prior.event_digest !== event.eventDigest ||
            prior.mint !== event.mint ||
            prior.pool !== event.pool
          )
            throw new Error('Finalized wallet fee evidence conflicts');
        }
      }
      return count;
    });
  }
  async pendingFeeEvents(
    network: string,
    mint: string,
    limit = 1000
  ): Promise<WalletFeeObservation[]> {
    const rows = (
      await this.db.query<{
        signature: string;
        instruction_index: number;
        event_index: number;
        pool: string;
        finalized_slot: string;
        phase: 0 | 1;
        net: string;
        event_digest: string;
      }>(
        `SELECT e.* FROM wallet_fee_events e WHERE e.network_genesis=$1 AND e.mint=$2 AND e.net>0 AND ${UNCONSUMED}
   AND NOT EXISTS(SELECT 1 FROM wallet_fee_reservations r WHERE r.network_genesis=e.network_genesis AND r.signature=e.signature AND r.instruction_index=e.instruction_index AND r.event_index=e.event_index)
   ORDER BY e.finalized_slot,e.signature,e.instruction_index,e.event_index LIMIT $3`,
        [network, mint, Math.max(1, Math.min(limit, 1000))]
      )
    ).rows;
    return rows.map((row) => ({
      id: {
        signature: row.signature,
        instructionIndex: row.instruction_index,
        eventIndex: row.event_index,
      },
      pool: row.pool,
      slot: Number(row.finalized_slot),
      phase: row.phase,
      net: BigInt(row.net),
      eventDigest: row.event_digest,
    }));
  }
  async queueCollection(
    network: string,
    mint: string,
    events: WalletFeeObservation[]
  ): Promise<WalletJob> {
    if (
      !events.length ||
      events.length > 1000 ||
      events.some((row) => row.pool !== events[0]!.pool)
    )
      throw new Error('A bounded single-pool event selection is required');
    return this.tx(async (client) => {
      await this.lock(client, network, mint);
      const coin = await this.coin(client, network, mint);
      const pending = (
        await client.query<WalletJob>(
          `SELECT * FROM wallet_jobs WHERE network_genesis=$1 AND mint=$2 AND kind='collect' AND status=ANY($3::text[])`,
          [network, mint, ACTIVE]
        )
      ).rows[0];
      if (pending) return pending;
      const pool = events[0]!.pool;
      const job = (
        await client.query<WalletJob>(
          `INSERT INTO wallet_jobs(id,network_genesis,mint,kind,intent_key,details)VALUES($1,$2,$3,'collect',$4,$5)RETURNING *`,
          [
            randomUUID(),
            network,
            mint,
            `collect:${randomUUID()}`,
            JSON.stringify({
              collector: coin.collector,
              treasury: coin.treasury,
              pool,
              route: pool === coin.dbc_pool ? 'dbc' : 'damm-v2',
              events: events.map((row) => row.id),
            }),
          ]
        )
      ).rows[0]!;
      const seen = new Set<string>();
      for (const selected of events) {
        const id = selected.id,
          key = `${id.signature}:${id.instructionIndex}:${id.eventIndex}`;
        if (seen.has(key)) throw new Error('Duplicate collection event');
        seen.add(key);
        const row = (
          await client.query<{ net: string; pool: string; event_digest: string }>(
            `SELECT e.net::text,e.pool,e.event_digest FROM wallet_fee_events e WHERE e.network_genesis=$1 AND e.mint=$2 AND e.signature=$3 AND e.instruction_index=$4 AND e.event_index=$5 AND ${UNCONSUMED}`,
            [network, mint, id.signature, id.instructionIndex, id.eventIndex]
          )
        ).rows[0];
        if (
          !row ||
          row.pool !== pool ||
          row.event_digest !== selected.eventDigest ||
          BigInt(row.net) !== selected.net
        )
          throw new Error('Collection event set changed');
        await client.query(
          'INSERT INTO wallet_fee_reservations(network_genesis,signature,instruction_index,event_index,job_id)VALUES($1,$2,$3,$4,$5)',
          [network, id.signature, id.instructionIndex, id.eventIndex, job.id]
        );
      }
      return job;
    });
  }
  async collectionEvents(job: WalletJob): Promise<WalletFeeObservation[]> {
    const rows = (
      await this.db.query<{
        signature: string;
        instruction_index: number;
        event_index: number;
        pool: string;
        finalized_slot: string;
        phase: 0 | 1;
        net: string;
        event_digest: string;
      }>(
        `SELECT e.* FROM wallet_fee_reservations r JOIN wallet_fee_events e USING(network_genesis,signature,instruction_index,event_index) WHERE r.job_id=$1 ORDER BY e.finalized_slot,e.signature,e.instruction_index,e.event_index`,
        [job.id]
      )
    ).rows;
    return rows.map((row) => ({
      id: {
        signature: row.signature,
        instructionIndex: row.instruction_index,
        eventIndex: row.event_index,
      },
      pool: row.pool,
      slot: Number(row.finalized_slot),
      phase: row.phase,
      net: BigInt(row.net),
      eventDigest: row.event_digest,
    }));
  }
  async queueBudget(input: {
    networkGenesis: string;
    mint: string;
    kind: 'buyback' | 'platform_claim';
    maximumLamports: bigint;
    minimumLamports?: bigint;
    intentKey?: string;
  }): Promise<WalletJob | null> {
    amount(input.maximumLamports);
    if (input.minimumLamports !== undefined) amount(input.minimumLamports);
    if (input.intentKey !== undefined && (!input.intentKey.length || input.intentKey.length > 200))
      throw new Error('Invalid wallet budget intent');
    return this.tx(async (client) => {
      const { networkGenesis: network, mint, kind } = input;
      await this.lock(client, network, mint);
      const coin = await this.coin(client, network, mint);
      const prior = (
        await client.query<WalletJob>(
          `SELECT * FROM wallet_jobs WHERE network_genesis=$1 AND mint=$2 AND kind=$3 AND status=ANY($4::text[]) ORDER BY created_at LIMIT 1`,
          [network, mint, kind, ACTIVE]
        )
      ).rows[0];
      if (prior) return prior;
      if (input.intentKey) {
        const attempted = await client.query(
          'SELECT id FROM wallet_jobs WHERE network_genesis=$1 AND mint=$2 AND kind=$3 AND intent_key=$4',
          [network, mint, kind, input.intentKey]
        );
        if (attempted.rows.length) return null;
      }
      const bucket = kind === 'buyback' ? 'rinse_buyback' : 'platform',
        balance = await this.balance(client, network, mint, bucket),
        available = BigInt(balance.funded) - BigInt(balance.spent) - BigInt(balance.reserved);
      let value = available < input.maximumLamports ? available : input.maximumLamports;
      if (kind === 'platform_claim' && coin.policy_version === 'bond-v1') {
        const operating = await this.operatingCapacity(client, network, coin.collector);
        const excess =
          operating.available -
          operating.reserved -
          operating.debt -
          BigInt(bondPolicy.operatingReserveLamports);
        if (excess < value) value = excess;
      }
      if (value <= 0n || value < (input.minimumLamports ?? 0n)) return null;
      await client.query(
        'UPDATE wallet_balances SET reserved=reserved+$4 WHERE network_genesis=$1 AND mint=$2 AND bucket=$3',
        [network, mint, bucket, value.toString()]
      );
      return (
        await client.query<WalletJob>(
          `INSERT INTO wallet_jobs(id,network_genesis,mint,kind,intent_key,bucket,recipient,lamports,details)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)RETURNING *`,
          [
            randomUUID(),
            network,
            mint,
            kind,
            input.intentKey ?? `${kind}:${randomUUID()}`,
            bucket,
            kind === 'platform_claim' ? coin.treasury : null,
            value.toString(),
            JSON.stringify({ collector: coin.collector, treasury: coin.treasury }),
          ]
        )
      ).rows[0]!;
    });
  }
  async queueSetup(network: string, mint: string): Promise<WalletJob> {
    return this.tx(async (client) => {
      await this.lock(client, network, mint);
      const coin = await this.coin(client, network, mint);
      const prior = (
        await client.query<WalletJob>(
          `SELECT * FROM wallet_jobs WHERE network_genesis=$1 AND mint=$2 AND kind='setup' AND status=ANY($3::text[])`,
          [network, mint, ACTIVE]
        )
      ).rows[0];
      if (prior) return prior;
      return (
        await client.query<WalletJob>(
          `INSERT INTO wallet_jobs(id,network_genesis,mint,kind,intent_key,details)VALUES($1,$2,$3,'setup',$4,$5)RETURNING *`,
          [
            randomUUID(),
            network,
            mint,
            `setup:${randomUUID()}`,
            JSON.stringify({ collector: coin.collector, treasury: coin.treasury }),
          ]
        )
      ).rows[0]!;
    });
  }
  async prepareJob(id: string, prepared: PreparedWalletExecution): Promise<WalletJob> {
    const bytes = Buffer.from(prepared.transactionBase64, 'base64'),
      tx = VersionedTransaction.deserialize(bytes);
    if (
      bytes.length > 1232 ||
      bytes.toString('base64') !== prepared.transactionBase64 ||
      messageDigest(tx.message.serialize()) !== prepared.messageDigest ||
      tx.signatures.some((row) => row.some((value) => value !== 0)) ||
      !Number.isSafeInteger(prepared.preparedSlot) ||
      prepared.preparedSlot < 0 ||
      !Number.isSafeInteger(prepared.lastValidBlockHeight) ||
      prepared.lastValidBlockHeight < 0
    )
      throw new Error('Exact bounded unsigned wallet transaction required');
    return this.tx(async (client) => {
      const job = (
        await client.query<WalletJob>('SELECT * FROM wallet_jobs WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      if (!job) throw new Error('Wallet job missing');
      const coin = await this.coin(client, job.network_genesis, job.mint);
      if (
        job.network_genesis !== prepared.networkGenesis ||
        job.mint !== prepared.mint ||
        job.kind !== prepared.kind ||
        ((isMskdMode(coin.mode) || isHsolMode(coin.mode)) &&
          (!coin.quote_mint || prepared.expectations.quoteMint !== coin.quote_mint)) ||
        prepared.expectations.collector !== coin.collector ||
        tx.message.staticAccountKeys[0]?.toBase58() !== coin.collector ||
        tx.message.header.numRequiredSignatures !== 1
      )
        throw new Error('Prepared wallet identity differs from its immutable job');
      if (
        job.recipient &&
        (prepared.expectations.recipient !== job.recipient ||
          prepared.expectations.expectedLamports !== job.lamports)
      )
        throw new Error('Prepared payout differs from its immutable entitlement');
      if (job.kind === 'buyback' && prepared.expectations.maximumSpendLamports !== job.lamports)
        throw new Error('Buyback exceeds its exact reserved budget');
      if (
        job.kind === 'wxmr_claim' &&
        (!isMaskedMode(coin.mode) ||
          !job.recipient ||
          prepared.expectations.maximumSpendLamports !== job.lamports ||
          prepared.expectations.pool !== job.details.market ||
          prepared.expectations.payoutMint !== job.details.assetMint)
      )
        throw new Error('Prepared wXMR payment differs from its claim');
      const mskdPayout = isMskdMode(coin.mode) && job.kind === 'community_claim';
      if (
        (job.kind === 'holder_conversion' &&
          (!isMskdMode(coin.mode) ||
            prepared.expectations.maximumSpendLamports !== job.lamports ||
            prepared.expectations.pool !== job.details.market)) ||
        ((job.kind === 'holder_conversion' || mskdPayout) &&
          prepared.expectations.payoutMint !== job.details.assetMint) ||
        (isHsolMode(coin.mode) &&
          ((job.kind === 'holder_conversion' && job.details.sourceMint !== HSOL_REWARD_MINT) ||
            ((job.kind === 'creator_claim' || (job.kind === 'community_claim' && !mskdPayout)) &&
              (job.details.assetMint !== HSOL_REWARD_MINT ||
                prepared.expectations.payoutMint !== undefined))))
      )
        throw new Error('Prepared operation differs from its immutable asset budget');
      const fee = prepared.expectations.maximumFeeLamports,
        operating = prepared.expectations.operatingCostLamports,
        temporary = prepared.expectations.temporaryFundingLamports ?? '0';
      if (
        typeof fee !== 'string' ||
        typeof operating !== 'string' ||
        !/^\d{1,20}$/.test(fee) ||
        !/^\d{1,20}$/.test(operating) ||
        typeof temporary !== 'string' ||
        !/^\d{1,20}$/.test(temporary) ||
        BigInt(operating) < BigInt(fee) ||
        BigInt(operating) + BigInt(temporary) > 18446744073709551615n
      )
        throw new Error('Explicit bounded operating fee/rent estimate required');
      if (job.status !== 'queued') return job;
      if (coin.policy_version === 'bond-v1') {
        const funds = await this.operatingCapacity(client, job.network_genesis, coin.collector);
        const incoming =
          job.kind === 'collect' && job.details.route === 'dbc'
            ? (BigInt(String(prepared.expectations.expectedLamports)) *
                BigInt(10_000 - bondPolicy.preBondBuybackNetBps)) /
              10_000n
            : 0n;
        if (funds.available + incoming < funds.reserved + funds.debt + BigInt(operating))
          throw new WalletOperatingUnavailable();
      }
      return (
        await client.query<WalletJob>(
          `UPDATE wallet_jobs SET transaction_base64=$2,message_digest=$3,prepared_slot=$4,last_valid_block_height=$5,expectations=$6,status='prepared',updated_at=now() WHERE id=$1 RETURNING *`,
          [
            id,
            prepared.transactionBase64,
            prepared.messageDigest,
            prepared.preparedSlot,
            prepared.lastValidBlockHeight,
            JSON.stringify(prepared.expectations),
          ]
        )
      ).rows[0]!;
    });
  }
  async attachSigned(id: string, wire: string): Promise<WalletJob> {
    return this.tx(async (client) => {
      const job = (
        await client.query<WalletJob>('SELECT * FROM wallet_jobs WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      if (!job?.message_digest || !job.transaction_base64)
        throw new Error('Prepared wallet job required');
      const signed = validateSignedTransaction(wire, job.message_digest);
      if (job.signature) {
        if (job.signature !== signed.signature || job.transaction_base64 !== wire)
          throw new Error('Another signed wallet attempt is already stored');
        return job;
      }
      if (job.status !== 'prepared') throw new Error('Wallet job is not signable');
      const collector = job.details.collector;
      if (typeof collector !== 'string') throw new Error('Wallet job collector is missing');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `wallet-signature:${job.network_genesis}:${collector}`,
      ]);
      await this.assertNoUnsettledSigned(job.network_genesis, collector, id, client);
      return (
        await client.query<WalletJob>(
          "UPDATE wallet_jobs SET transaction_base64=$2,signature=$3,status='signed',updated_at=now()WHERE id=$1 RETURNING *",
          [id, wire, signed.signature]
        )
      ).rows[0]!;
    });
  }
  async markSubmitted(id: string): Promise<WalletJob> {
    const row = (
      await this.db.query<WalletJob>(
        `UPDATE wallet_jobs SET status='submitted',updated_at=now()WHERE id=$1 AND signature IS NOT NULL AND status IN('signed','submitted','manual_review')RETURNING *`,
        [id]
      )
    ).rows[0];
    if (!row) throw new Error('Stored signed wallet attempt required');
    return row;
  }
  async markUncertain(id: string) {
    await this.db.query(
      "UPDATE wallet_jobs SET status='manual_review',updated_at=now()WHERE id=$1 AND status='submitted'",
      [id]
    );
  }
  async settle(id: string, effect: WalletEffectFacts): Promise<WalletJob> {
    assertVerifiedWalletEffect(effect);
    const identity = await this.job(id);
    if (!identity) throw new Error('Wallet job missing');
    return this.tx(async (client) => {
      await this.lock(client, identity.network_genesis, identity.mint);
      const job = (
        await client.query<WalletJob>('SELECT * FROM wallet_jobs WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      if (
        !job ||
        job.network_genesis !== effect.networkGenesis ||
        job.mint !== effect.mint ||
        job.kind !== effect.kind ||
        job.signature !== effect.signature ||
        job.message_digest !== effect.messageDigest
      )
        throw new Error('Finalized wallet effect differs from stored signed attempt');
      if (job.status === 'finalized') {
        if (
          Number(job.finalized_slot) !== effect.slot ||
          BigInt(job.received_lamports) !== (effect.receivedLamports ?? 0n) ||
          BigInt(job.burned_tokens) !== (effect.burnedTokens ?? 0n)
        )
          throw new Error('Verified effect conflicts with the finalized wallet receipt');
        if (job.kind === 'holder_conversion') await settleMskdConversion(client, job, effect);
        else if (job.kind === 'wxmr_claim') await settleWxmrPayment(client, job, effect);
        else await this.recordSettlement(client, job, effect);
        return job;
      }
      if (!['signed', 'submitted', 'manual_review'].includes(job.status))
        throw new Error('Wallet attempt cannot settle');
      const coin = await this.coin(client, job.network_genesis, job.mint);
      if (job.kind === 'collect') await this.settleCollection(client, coin, job, effect);
      else if (job.kind === 'holder_conversion') await settleMskdConversion(client, job, effect);
      else if (job.kind === 'wxmr_claim') await settleWxmrPayment(client, job, effect);
      else if (job.kind !== 'setup' && !(isMskdMode(coin.mode) && job.kind === 'community_claim')) {
        const reserved = BigInt(job.lamports),
          spent = job.kind === 'buyback' ? effect.collectorDebitLamports : effect.paidLamports;
        if (
          spent === undefined ||
          spent <= 0n ||
          spent > reserved ||
          (job.kind !== 'buyback' && (spent !== reserved || effect.recipient !== job.recipient)) ||
          (job.kind === 'buyback' && (!effect.burnedTokens || effect.burnedTokens <= 0n))
        )
          throw new Error('Finalized payment/burn amount differs');
        await this.balance(client, job.network_genesis, job.mint, job.bucket!);
        await client.query(
          'UPDATE wallet_balances SET reserved=reserved-$4,spent=spent+$5 WHERE network_genesis=$1 AND mint=$2 AND bucket=$3',
          [job.network_genesis, job.mint, job.bucket, reserved.toString(), spent.toString()]
        );
      }
      if (coin.policy_version === 'bond-v1') {
        if (effect.operatingCostLamports === undefined)
          throw new Error('Verified operating expense required');
        await this.recordOperatingCost(client, coin, job, effect.operatingCostLamports);
      }
      if (isMskdMode(coin.mode) || isHsolMode(coin.mode))
        await this.recordSplExpense(client, job, effect.operatingCostLamports);
      if (job.kind !== 'holder_conversion' && job.kind !== 'wxmr_claim')
        await this.recordSettlement(client, job, effect);
      return (
        await client.query<WalletJob>(
          `UPDATE wallet_jobs SET status='finalized',finalized_slot=$2,received_lamports=$3,burned_tokens=$4,updated_at=now()WHERE id=$1 RETURNING *`,
          [
            id,
            effect.slot,
            (effect.receivedLamports ?? 0n).toString(),
            (effect.burnedTokens ?? 0n).toString(),
          ]
        )
      ).rows[0]!;
    });
  }
  private async recordSplExpense(client: PoolClient, job: WalletJob, lamports?: bigint) {
    if (lamports === undefined || !job.signature)
      throw new Error('Verified operating expense for the SPL settlement required');
    await client.query(
      'INSERT INTO wallet_mode_sol_expenses(job_id,signature,lamports)VALUES($1,$2,$3)',
      [job.id, job.signature, lamports.toString()]
    );
  }
  private async recordSettlement(client: PoolClient, job: WalletJob, effect: WalletEffectFacts) {
    const received = effect.receivedLamports ?? 0n,
      paid = effect.paidLamports ?? 0n,
      spent = effect.collectorDebitLamports ?? 0n,
      burned = effect.burnedTokens ?? 0n;
    if (
      (job.kind.endsWith('_claim') &&
        (paid !== BigInt(job.lamports) ||
          effect.recipient !== job.recipient ||
          spent !== (job.recipient === job.expectations.collector ? 0n : paid))) ||
      (job.kind === 'buyback' && (spent <= 0n || spent > BigInt(job.lamports)))
    )
      throw new Error('Settlement fact differs from the immutable cash entitlement');
    const inserted = await client.query(
      `INSERT INTO wallet_settlements(job_id,network_genesis,mint,kind,signature,message_digest,finalized_slot,received_lamports,paid_lamports,actual_spent_lamports,burned_tokens)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)ON CONFLICT DO NOTHING RETURNING job_id`,
      [
        job.id,
        job.network_genesis,
        job.mint,
        job.kind,
        effect.signature,
        effect.messageDigest,
        effect.slot,
        received.toString(),
        paid.toString(),
        spent.toString(),
        burned.toString(),
      ]
    );
    if (!inserted.rows.length) {
      const previous = (
        await client.query<{
          network_genesis: string;
          mint: string;
          kind: string;
          signature: string;
          message_digest: string;
          finalized_slot: string;
          received_lamports: string;
          paid_lamports: string;
          actual_spent_lamports: string;
          burned_tokens: string;
        }>('SELECT * FROM wallet_settlements WHERE job_id=$1', [job.id])
      ).rows[0];
      if (
        !previous ||
        previous.network_genesis !== job.network_genesis ||
        previous.mint !== job.mint ||
        previous.kind !== job.kind ||
        previous.signature !== effect.signature ||
        previous.message_digest !== effect.messageDigest ||
        Number(previous.finalized_slot) !== effect.slot ||
        BigInt(previous.received_lamports) !== received ||
        BigInt(previous.paid_lamports) !== paid ||
        BigInt(previous.actual_spent_lamports) !== spent ||
        BigInt(previous.burned_tokens) !== burned
      )
        throw new Error('A different immutable wallet settlement is already recorded');
    }
  }
  private async settleCollection(
    client: PoolClient,
    coin: WalletCoin,
    job: WalletJob,
    effect: WalletEffectFacts
  ) {
    const network = job.network_genesis,
      mint = job.mint,
      pool = String(job.details.pool),
      damm = job.details.route === 'damm-v2',
      received = effect.receivedLamports;
    if (received === undefined || received <= 0n || job.expectations.pool !== pool)
      throw new Error('Positive independently received canonical income required');
    let rows: Array<{
        signature: string;
        instruction_index: number;
        event_index: number;
        phase: 0 | 1;
        net: string;
      }>,
      prefix: string[] = [];
    if (damm) {
      const signatures = effect.slotSignatures;
      if (
        !signatures ||
        !Number.isSafeInteger(effect.transactionIndex) ||
        effect.transactionIndex < 0 ||
        signatures[effect.transactionIndex] !== effect.signature ||
        new Set(signatures).size !== signatures.length
      )
        throw new Error('Canonical collection block order required');
      prefix = signatures.slice(0, effect.transactionIndex + 1);
      const cursor = (
        await client.query<{
          complete: boolean;
          scan_head_signature: string | null;
          finalized_slot: string;
        }>('SELECT * FROM wallet_index_cursors WHERE network_genesis=$1 AND pool=$2', [
          network,
          pool,
        ])
      ).rows[0];
      if (
        !cursor?.complete ||
        cursor.scan_head_signature ||
        BigInt(cursor.finalized_slot) < BigInt(effect.slot)
      )
        throw new Error('Index must catch up through finalized claim before cash allocation');
      const observed = (
        await client.query<{ net: string; invalid: string }>(
          `SELECT coalesce(sum(e.net),0)::text AS net,count(*)FILTER(WHERE e.phase<>1)::text AS invalid FROM wallet_fee_events e WHERE e.network_genesis=$1 AND e.mint=$2 AND e.pool=$3 AND ${UNCONSUMED}
     AND(e.finalized_slot<$4 OR(e.finalized_slot=$4 AND e.signature=ANY($5::text[])))`,
          [network, mint, pool, effect.slot, prefix]
        )
      ).rows[0]!;
      if (BigInt(observed.invalid) !== 0n)
        throw new Error('Graduated income cannot contain RINSE observations');
      rows = [
        {
          signature: effect.signature,
          instruction_index: 0,
          event_index: 0,
          phase: 1,
          net: observed.net,
        },
      ];
    } else {
      rows = (
        await client.query<{
          signature: string;
          instruction_index: number;
          event_index: number;
          phase: 0 | 1;
          net: string;
        }>(
          `SELECT e.signature,e.instruction_index,e.event_index,e.phase,e.net::text FROM wallet_fee_reservations r JOIN wallet_fee_events e USING(network_genesis,signature,instruction_index,event_index)WHERE r.job_id=$1`,
          [job.id]
        )
      ).rows;
      if (rows.length !== (job.details.events as unknown[]).length)
        throw new Error('Reserved DBC event set is incomplete');
      if (coin.policy_version === 'bond-v1' && rows.some((row) => row.phase !== 0))
        throw new Error('Bond it. DBC income cannot fund post-bond payouts');
    }
    const raw = rows.reduce((sum, row) => sum + BigInt(row.net), 0n);
    if (raw < received || (!damm && raw !== received))
      throw new Error('Received cash differs from complete observed collectible fees');
    const rinse = damm
        ? 0n
        : rows.filter((row) => row.phase === 0).reduce((sum, row) => sum + BigInt(row.net), 0n),
      post = received - rinse;
    await client.query(
      'INSERT INTO wallet_phase_totals(network_genesis,mint)VALUES($1,$2)ON CONFLICT DO NOTHING',
      [network, mint]
    );
    const totals = (
      await client.query<{ rinse_net: string; post_net: string }>(
        'SELECT rinse_net::text,post_net::text FROM wallet_phase_totals WHERE network_genesis=$1 AND mint=$2 FOR UPDATE',
        [network, mint]
      )
    ).rows[0]!;
    const allocations = {
      rinse_buyback: 0n,
      creator: 0n,
      community: 0n,
      platform: 0n,
      mskd_buyback: 0n,
    };
    for (const [phase, net, previous] of [
      ['rinse', rinse, BigInt(totals.rinse_net)],
      ['post', post, BigInt(totals.post_net)],
    ] as const) {
      const a = allocateExecutedFee({
        total: net,
        protocol: 0n,
        activationTime: Number(coin.activation_point),
        tradeTime: Number(coin.activation_point) + (phase === 'post' ? 27 : 0),
        mode: coin.mode,
        phase,
        previousPhaseNet: previous,
        creatorShareBps: coin.creator_share_bps,
      });
      allocations.rinse_buyback += a.rinseBuyback;
      allocations.mskd_buyback += a.mskdBuyback;
      allocations.creator += a.creator;
      allocations.community += a.community;
      allocations.platform += a.platform;
    }
    await client.query(
      `INSERT INTO wallet_collections(job_id,network_genesis,mint,pool,signature,finalized_slot,transaction_index,received,raw_observed,rinse_net,post_net,rinse_buyback,creator,community,platform,mskd_buyback)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        job.id,
        network,
        mint,
        pool,
        effect.signature,
        effect.slot,
        effect.transactionIndex,
        received.toString(),
        raw.toString(),
        rinse.toString(),
        post.toString(),
        allocations.rinse_buyback.toString(),
        allocations.creator.toString(),
        allocations.community.toString(),
        allocations.platform.toString(),
        allocations.mskd_buyback.toString(),
      ]
    );
    for (const bucket of BUCKETS) {
      await this.balance(client, network, mint, bucket);
      await client.query(
        'UPDATE wallet_balances SET funded=funded+$4 WHERE network_genesis=$1 AND mint=$2 AND bucket=$3',
        [network, mint, bucket, allocations[bucket].toString()]
      );
    }
    await client.query(
      'UPDATE wallet_phase_totals SET rinse_net=rinse_net+$3,post_net=post_net+$4 WHERE network_genesis=$1 AND mint=$2',
      [network, mint, rinse.toString(), post.toString()]
    );
    if (damm) {
      const prior = (
        await client.query<{ finalized_slot: string; transaction_index: number }>(
          'SELECT finalized_slot::text,transaction_index FROM wallet_collection_cursors WHERE network_genesis=$1 AND pool=$2 FOR UPDATE',
          [network, pool]
        )
      ).rows[0];
      if (
        prior &&
        (BigInt(prior.finalized_slot) > BigInt(effect.slot) ||
          (BigInt(prior.finalized_slot) === BigInt(effect.slot) &&
            prior.transaction_index >= effect.transactionIndex))
      )
        throw new Error('Collection boundary cannot regress');
      await client.query(
        `INSERT INTO wallet_collection_cursors(network_genesis,mint,pool,job_id,finalized_slot,transaction_index,slot_signatures)VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(network_genesis,pool)DO UPDATE SET job_id=EXCLUDED.job_id,finalized_slot=EXCLUDED.finalized_slot,transaction_index=EXCLUDED.transaction_index,slot_signatures=EXCLUDED.slot_signatures`,
        [network, mint, pool, job.id, effect.slot, effect.transactionIndex, JSON.stringify(prefix)]
      );
    } else
      for (const row of rows)
        await client.query(
          'INSERT INTO wallet_collected_events(network_genesis,signature,instruction_index,event_index,job_id)VALUES($1,$2,$3,$4,$5)',
          [network, row.signature, row.instruction_index, row.event_index, job.id]
        );
    await client.query('DELETE FROM wallet_fee_reservations WHERE job_id=$1', [job.id]);
  }
  async renew(id: string, proof: WalletRecoveryProof): Promise<WalletJob> {
    assertWalletRecoveryProof(proof);
    const identity = await this.job(id);
    if (!identity) throw new Error('Wallet job missing');
    return this.tx(async (client) => {
      await this.lock(client, identity.network_genesis, identity.mint);
      const job = (
        await client.query<WalletJob>('SELECT * FROM wallet_jobs WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      if (
        !job ||
        proof.jobId !== id ||
        proof.networkGenesis !== job.network_genesis ||
        proof.messageDigest !== job.message_digest ||
        proof.signature !== job.signature ||
        proof.preparedSlot !== Number(job.prepared_slot) ||
        proof.lastValidBlockHeight !== Number(job.last_valid_block_height) ||
        !job.transaction_base64 ||
        !['prepared', 'signed', 'submitted', 'manual_review'].includes(job.status)
      )
        throw new Error('Positive expiry proof differs from current immutable attempt');
      await client.query(
        `INSERT INTO wallet_job_attempts(job_id,message_digest,transaction_base64,signature,prepared_slot,last_valid_block_height,finalized_expiry_height,proof_slot,proof)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          job.message_digest,
          job.transaction_base64,
          job.signature,
          job.prepared_slot,
          job.last_valid_block_height,
          proof.finalizedHeight,
          proof.proofSlot,
          JSON.stringify(proof),
        ]
      );
      return (
        await client.query<WalletJob>(
          `UPDATE wallet_jobs SET status='queued',transaction_base64=NULL,message_digest=NULL,prepared_slot=NULL,last_valid_block_height=NULL,signature=NULL,expectations='{}',updated_at=now()WHERE id=$1 RETURNING *`,
          [id]
        )
      ).rows[0]!;
    });
  }
  async recordFailure(id: string, proof: FinalizedFailure): Promise<WalletJob> {
    assertFinalizedFailure(proof);
    const identity = await this.job(id);
    if (!identity) throw new Error('Wallet job missing');
    return this.tx(async (client) => {
      await this.lock(client, identity.network_genesis, identity.mint);
      const job = (
        await client.query<WalletJob>('SELECT * FROM wallet_jobs WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      if (
        !job ||
        job.network_genesis !== proof.networkGenesis ||
        job.signature !== proof.signature ||
        job.message_digest !== proof.messageDigest
      )
        throw new Error('Finalized failure differs from wallet attempt');
      if (job.status === 'failed') return job;
      if (!['signed', 'submitted', 'manual_review'].includes(job.status))
        throw new Error('Wallet job cannot fail');
      const coin = await this.coin(client, job.network_genesis, job.mint);
      if (coin.policy_version === 'bond-v1') {
        if (proof.feeLamports === undefined)
          throw new Error('Verified failed transaction fee required');
        await this.recordOperatingCost(client, coin, job, proof.feeLamports);
      }
      if (isMskdMode(coin.mode) || isHsolMode(coin.mode))
        await this.recordSplExpense(client, job, proof.feeLamports);
      if (job.bucket && job.kind !== 'community_claim')
        await client.query(
          'UPDATE wallet_balances SET reserved=reserved-$4 WHERE network_genesis=$1 AND mint=$2 AND bucket=$3',
          [job.network_genesis, job.mint, job.bucket, job.lamports]
        );
      await client.query('DELETE FROM wallet_fee_reservations WHERE job_id=$1', [id]);
      return (
        await client.query<WalletJob>(
          "UPDATE wallet_jobs SET status='failed',finalized_slot=$2,updated_at=now()WHERE id=$1 RETURNING *",
          [id, proof.slot]
        )
      ).rows[0]!;
    });
  }
}
