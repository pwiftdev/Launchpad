import { createHash, randomUUID } from 'node:crypto';
import { ComputeBudgetProgram, PublicKey, VersionedTransaction } from '@solana/web3.js';
import type { Pool, PoolClient } from 'pg';
import { database } from '../database';
import type { RegisteredCoin } from '../launchRegistry';
import { verifiedFinancialPool } from '../migrationRegistry';
import { assertHolderSnapshot, type FinalizedHolderSnapshot } from './holderSnapshot';
import { buildRewardMerkle } from './rewardMerkle';
import { epochAddress, vaultAddresses, u64, digest32 } from '@/lib/vault/client';
import {
  claimCreatorInstruction,
  claimCommunityInstruction,
  claimPlatformInstruction,
} from '@/lib/vault/client';
import discriminators from '@/lib/vault/discriminators.json';
import { allocateExecutedFee, allocateHolderSnapshot } from './feeLedger';
import { assertVerifiedFee, feeEventKey, type VerifiedFeeEvent } from './feeIngestion';
import {
  assertFinalizedEvidence,
  messageDigest,
  lamportDelta,
  tokenDelta,
  requireInstruction,
  closedNativeAccountRent,
  validateSignedTransaction,
  assertFinalizedClock,
  type FinalizedClock,
  type FinalizedEvidence,
} from './chainEvidence';
import { actualBurnedTokens, purchasedTokens, netClaimCredit } from './chainEvidence';
import { allInstructions } from './chainEvidence';
import { assertFundingReceipt, type VerifiedFundingReceipt } from './fundingReceipt';
import { assertFinalizedFailure, type FinalizedFailure } from './chainEvidence';
import { readEvidenceAccount } from './chainEvidence';
import { claimAddress } from '@/lib/vault/client';
import { assertUnsignedClaimExpiry, type UnsignedClaimExpiry } from './claimRecovery';
import { assertUnsignedBuybackExpiry, type UnsignedBuybackExpiry } from './claimRecovery';
import { assertDammRealization, type VerifiedDammRealization } from './dammRealization';
import { recordFinalizedDammWindows } from './realizationFacts';
import { assertCommunityClaimRenewal, type CommunityClaimRenewal } from './claimRenewal';

export type Bucket = 'rinse_buyback' | 'creator' | 'community' | 'platform';
export type JobKind = 'buyback' | 'burn' | 'creator_claim' | 'community_claim' | 'platform_claim';
export type EventId = { signature: string; instructionIndex: number; eventIndex: number };
type FundingEventRow = {
  signature: string;
  instruction_index: number;
  event_index: number;
  rinse_buyback: string;
  creator: string;
  community: string;
  platform: string;
  event_digest: string;
  total: string;
  protocol: string;
  referral: string;
  trade_time: string;
  phase: 0 | 1;
  pool: string;
};
export type FundingSourceKind = 'dbc_claim' | 'damm_claim' | 'collected_allocation';
export type FundingPlan = {
  commitment: string;
  fundingId: string;
  lamports: bigint;
  pool: string;
  migrated: boolean;
  sourceKind: FundingSourceKind;
  events: { id: EventId; phase: 0 | 1; net: bigint }[];
  phases: { phase: 0 | 1; net: bigint }[];
  allocation: Record<Bucket, bigint>;
  realization?: {
    rawCommitment: string;
    rawExpected: bigint;
    realizedNet: bigint;
    shortfall: bigint;
    externalLpExcluded: bigint;
    roundingLoss: bigint;
    proofDigest: string;
  };
};
export type ExecutionExpectation = {
  program: string;
  accounts: string[];
  dataBase64: string;
  vault: string;
  effect: 'sol_claim' | 'buyback' | 'buyback_burn' | 'burn';
  tokenAccount?: string;
  poolTokenVault?: string;
  minTokens?: string;
  unwrapAccount?: string;
};
export type PreparedExecution = {
  networkGenesis: string;
  mint: string;
  intentKey: string;
  kind: JobKind;
  lamports: bigint;
  tokens?: bigint;
  recipient?: string;
  epoch?: number;
  parentJob?: string;
  transactionBase64: string;
  lastValidBlockHeight: number;
  expectation: ExecutionExpectation;
  clock: FinalizedClock;
};
export type FinancialJob = {
  id: string;
  network_genesis: string;
  mint: string;
  intent_key: string;
  kind: JobKind;
  bucket: Bucket | null;
  lamports: string;
  tokens: string;
  recipient: string | null;
  epoch: string | null;
  parent_job: string | null;
  status: 'prepared' | 'signed' | 'submitted' | 'finalized' | 'failed' | 'manual_review';
  transaction_base64: string;
  message_digest: string;
  signature: string | null;
  last_valid_block_height: string;
  finalized_slot: string | null;
  received_tokens: string;
  expectations: ExecutionExpectation;
};
export type FinancialEpoch = {
  network_genesis: string;
  mint: string;
  epoch: string;
  snapshot_slot: string;
  snapshot_time: string;
  snapshot_digest: string;
  merkle_root: string;
  status: 'prepared' | 'funded';
  funding_signature: string | null;
  funding_slot: string | null;
  budget: string;
  allocated: string;
  carry: string;
};
export type ClaimableReward = {
  epoch: string;
  wallet: string;
  lamports: string;
  proof: string[];
  merkle_root: string;
  snapshot_slot: string;
  status: 'available' | 'pending' | 'paid';
  job_id: string | null;
  job_status?: string | null;
  signature: string | null;
};
export type FinancialIndexCursor = {
  network_genesis: string;
  pool: string;
  newest_signature: string | null;
  oldest_signature: string | null;
  complete: boolean;
  scan_head_signature: string | null;
  scan_before_signature: string | null;
  scan_until_signature: string | null;
  finalized_slot: string;
  version: string;
};

const buckets: Bucket[] = ['rinse_buyback', 'creator', 'community', 'platform'];
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const realizedFundingCommitment = (
  rawCommitment: string,
  realizedNet: bigint,
  shortfall: bigint,
  proofDigest: string
) =>
  digest({
    version: 'damm-realization-v1',
    rawCommitment,
    realizedNet: realizedNet.toString(),
    shortfall: shortfall.toString(),
    proofDigest,
  });
const bucketValues = (a: ReturnType<typeof allocateExecutedFee>) => [
  a.rinseBuyback,
  a.creator,
  a.community,
  a.platform,
];
const expectedBucket = (kind: JobKind): Bucket | null =>
  ({
    buyback: 'rinse_buyback',
    burn: null,
    creator_claim: 'creator',
    community_claim: 'community',
    platform_claim: 'platform',
  })[kind] as Bucket | null;

export function encodeFundingPlan(plan: FundingPlan): Buffer {
  if (
    !/^[a-f0-9]{64}$/.test(plan.fundingId) ||
    plan.fundingId !== plan.commitment ||
    plan.phases.length < 1 ||
    plan.phases.length > 2
  )
    throw new Error('Invalid funding commitment');
  const count = Buffer.alloc(2);
  count.writeUInt16LE(plan.phases.length);
  const entries = plan.phases.map((event) => {
    if (![0, 1].includes(event.phase) || event.net <= 0n || event.net > 18446744073709551615n)
      throw new Error('Invalid phase funding');
    const bytes = Buffer.alloc(9);
    bytes[0] = event.phase;
    bytes.writeBigUInt64LE(event.net, 1);
    return bytes;
  });
  const instructionName =
    plan.sourceKind === 'collected_allocation'
      ? 'allocate_collected_fees'
      : plan.migrated
        ? 'collect_damm_fees'
        : 'collect_fees';
  const tag =
    instructionName === 'allocate_collected_fees'
      ? createHash('sha256').update('global:allocate_collected_fees').digest().subarray(0, 8)
      : Buffer.from(discriminators[instructionName]);
  return Buffer.concat([
    tag,
    Buffer.from(plan.fundingId, 'hex'),
    Buffer.from(plan.commitment, 'hex'),
    count,
    ...entries,
  ]);
}

/** All accounting updates commit atomically. SQL is a shadow ledger; custody stays in the program. */
export class FinancialStore {
  constructor(
    private readonly pool: Pick<Pool, 'connect'> = database(),
    private readonly vaultProgram = process.env.VAULT_PROGRAM_ID ?? '',
    private readonly verifyPool = verifiedFinancialPool
  ) {}

  private async tx<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if ((error as { code?: string }).code !== '40001' || attempt === 2) throw error;
      } finally {
        client.release();
      }
    }
    throw new Error('Financial transaction could not be serialized');
  }

  private async coin(client: PoolClient, network: string, mint: string): Promise<RegisteredCoin> {
    const row = (
      await client.query<RegisteredCoin>(
        'SELECT * FROM launch_coins WHERE network_genesis=$1 AND mint=$2 FOR SHARE',
        [network, mint]
      )
    ).rows[0];
    if (!row || row.policy_version !== 'rinse-v1')
      throw new Error('An immutable reviewed coin policy is required');
    return row;
  }

  private async balance(client: PoolClient, network: string, mint: string, bucket: Bucket) {
    await client.query(
      `INSERT INTO financial_balances(network_genesis,mint,bucket) VALUES($1,$2,$3)
      ON CONFLICT DO NOTHING`,
      [network, mint, bucket]
    );
    return (
      await client.query<{ accrued: string; funded: string; reserved: string; spent: string }>(
        `SELECT accrued,funded,reserved,spent FROM financial_balances
       WHERE network_genesis=$1 AND mint=$2 AND bucket=$3 FOR UPDATE`,
        [network, mint, bucket]
      )
    ).rows[0]!;
  }

  private async phase(client: PoolClient, network: string, mint: string, phase: 0 | 1) {
    await client.query(
      `INSERT INTO financial_phase_totals(network_genesis,mint,phase) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      [network, mint, phase]
    );
    return (
      await client.query<{ observed_net: string; funded_net: string }>(
        `SELECT observed_net,funded_net FROM financial_phase_totals
      WHERE network_genesis=$1 AND mint=$2 AND phase=$3 FOR UPDATE`,
        [network, mint, phase]
      )
    ).rows[0]!;
  }

  private async loadFundingPlan(
    client: PoolClient,
    network: string,
    mint: string,
    ids: EventId[],
    allowFunded = false,
    sourceKind?: FundingSourceKind
  ): Promise<FundingPlan> {
    const coin = await this.coin(client, network, mint);
    const sorted = [...ids].sort((a, b) => feeEventKey(a).localeCompare(feeEventKey(b), 'en'));
    if (
      !sorted.length ||
      sorted.length > 10_000 ||
      new Set(sorted.map(feeEventKey)).size !== sorted.length
    )
      throw new Error('Funding requires a bounded unique executed-fee set');
    const rows: FundingEventRow[] = [];
    for (const id of sorted) {
      const row = (
        await client.query<FundingEventRow>(
          `SELECT e.* FROM financial_fee_events e
        WHERE e.network_genesis=$1 AND e.mint=$2 AND e.signature=$3 AND e.instruction_index=$4 AND e.event_index=$5
        ${
          allowFunded
            ? ''
            : `AND NOT EXISTS(SELECT 1 FROM financial_funded_events f WHERE f.network_genesis=e.network_genesis
          AND f.signature=e.signature AND f.instruction_index=e.instruction_index AND f.event_index=e.event_index)
          AND NOT EXISTS(SELECT 1 FROM financial_zero_fee_events z WHERE z.network_genesis=e.network_genesis
            AND z.signature=e.signature AND z.instruction_index=e.instruction_index AND z.event_index=e.event_index)`
        }
        FOR SHARE`,
          [network, mint, id.signature, id.instructionIndex, id.eventIndex]
        )
      ).rows[0];
      if (!row) throw new Error('Executed fee is unknown or already funded');
      rows.push(row);
    }
    const events = rows.map((row, index) => ({
      id: sorted[index]!,
      phase: row.phase,
      net: BigInt(row.total) - BigInt(row.protocol) - BigInt(row.referral),
    }));
    if (new Set(rows.map((row) => row.pool)).size !== 1)
      throw new Error('One funding claim cannot combine different DEX pools');
    const rawLamports = events.reduce((sum, event) => sum + event.net, 0n);
    const rawCommitment = digest({
      network,
      mint,
      mode: coin.mode,
      events: rows.map((row, index) => [
        row.signature,
        row.instruction_index,
        row.event_index,
        row.event_digest,
        events[index]!.phase,
        events[index]!.net.toString(),
      ]),
    });
    const migrated = rows[0]!.pool !== coin.dbc_pool;
    const realized = (
      await client.query<{
        realized_commitment: string;
        raw_expected: string;
        realized_net: string;
        shortfall: string;
        external_lp_excluded: string;
        rounding_loss: string;
        proof_digest: string;
      }>(
        `SELECT realized_commitment,raw_expected,realized_net,shortfall,external_lp_excluded,rounding_loss,proof_digest FROM financial_funding_realizations
       WHERE network_genesis=$1 AND mint=$2 AND raw_commitment=$3`,
        [network, mint, rawCommitment]
      )
    ).rows[0];
    const realization = realized
      ? {
          rawCommitment,
          rawExpected: BigInt(realized.raw_expected),
          realizedNet: BigInt(realized.realized_net),
          shortfall: BigInt(realized.shortfall),
          externalLpExcluded: BigInt(realized.external_lp_excluded),
          roundingLoss: BigInt(realized.rounding_loss),
          proofDigest: realized.proof_digest,
        }
      : undefined;
    if (
      realization &&
      (!migrated ||
        events.some((event) => event.phase !== 1) ||
        realization.rawExpected !== rawLamports ||
        realization.realizedNet <= 0n ||
        realization.shortfall < 0n ||
        realization.externalLpExcluded < 0n ||
        realization.roundingLoss < 0n ||
        realization.shortfall !== realization.externalLpExcluded + realization.roundingLoss ||
        realization.rawExpected !== realization.realizedNet + realization.shortfall ||
        realized!.realized_commitment !==
          realizedFundingCommitment(
            rawCommitment,
            realization.realizedNet,
            realization.shortfall,
            realization.proofDigest
          ))
    )
      throw new Error('Realized funding does not match immutable raw DAMM events');
    const lamports = realization?.realizedNet ?? rawLamports;
    if (lamports <= 0n || lamports > 18446744073709551615n)
      throw new Error('Invalid funding amount');
    const phases = realization
      ? [{ phase: 1 as const, net: lamports }]
      : ([0, 1] as const)
          .map((phase) => ({
            phase,
            net: events
              .filter((event) => event.phase === phase)
              .reduce((sum, event) => sum + event.net, 0n),
          }))
          .filter((phase) => phase.net > 0n);
    const allocation = { rinse_buyback: 0n, creator: 0n, community: 0n, platform: 0n };
    for (const item of phases) {
      const previous = await this.phase(client, network, mint, item.phase);
      const value = allocateExecutedFee({
        total: item.net,
        protocol: 0n,
        activationTime: Number(coin.activation_point),
        tradeTime: Number(coin.activation_point),
        mode: coin.mode,
        previousPhaseNet: BigInt(previous.funded_net),
        phase: item.phase === 0 ? 'rinse' : 'post',
      });
      const amounts = bucketValues(value);
      for (let i = 0; i < buckets.length; i++) allocation[buckets[i]!] += amounts[i]!;
    }
    const commitment = realized?.realized_commitment ?? rawCommitment;
    const kind = sourceKind ?? (migrated ? 'damm_claim' : 'dbc_claim');
    if (
      ((kind === 'damm_claim' || kind === 'collected_allocation') && !migrated) ||
      (kind === 'dbc_claim' && migrated)
    )
      throw new Error('Funding route does not match the verified DEX pool');
    return {
      commitment,
      fundingId: commitment,
      lamports,
      pool: rows[0]!.pool,
      migrated,
      sourceKind: kind,
      events,
      phases,
      allocation,
      realization,
    };
  }

  async fundingPlan(
    network: string,
    mint: string,
    events: EventId[],
    sourceKind?: FundingSourceKind
  ): Promise<FundingPlan> {
    return this.tx(async (client) => {
      const plan = await this.loadFundingPlan(client, network, mint, events, false, sourceKind);
      return this.saveFundingPlan(client, network, mint, plan);
    });
  }

  async previewFundingPlan(
    network: string,
    mint: string,
    events: EventId[],
    sourceKind?: FundingSourceKind,
    allowFunded = false
  ) {
    return this.tx((client) =>
      this.loadFundingPlan(client, network, mint, events, allowFunded, sourceKind)
    );
  }

  async recordDammWindowProof(proof: VerifiedDammRealization) {
    assertDammRealization(proof);
    return this.tx(async (client) => {
      await this.coin(client, proof.networkGenesis, proof.mint);
      await recordFinalizedDammWindows(client, proof);
    });
  }

  private async accountedDamm(client: PoolClient, network: string, mint: string, pool: string) {
    const row = (
      await client.query<{ realized: string; external: string; rounding: string }>(
        `SELECT COALESCE(sum(f.lamports),0)::text AS realized,
      COALESCE(sum(r.external_lp_excluded),0)::text AS external,COALESCE(sum(r.rounding_loss),0)::text AS rounding
      FROM financial_funding f LEFT JOIN financial_funding_rounding r USING(network_genesis,mint,commitment)
      WHERE f.network_genesis=$1 AND f.mint=$2 AND EXISTS(SELECT 1 FROM financial_funded_events fe
        JOIN financial_fee_events e USING(network_genesis,signature,instruction_index,event_index)
        WHERE fe.network_genesis=f.network_genesis AND fe.funding_signature=f.signature AND fe.funding_instruction_index=f.instruction_index AND e.pool=$3)`,
        [network, mint, pool]
      )
    ).rows[0]!;
    return {
      accountedRealizedNet: BigInt(row.realized),
      accountedExternalLpExcluded: BigInt(row.external),
      accountedRoundingLoss: BigInt(row.rounding),
    };
  }

  async dammAccountedTotals(network: string, mint: string, pool: string) {
    return this.tx((client) => this.accountedDamm(client, network, mint, pool));
  }

  async reserveRealizedFunding(
    network: string,
    mint: string,
    events: EventId[],
    sourceKind: FundingSourceKind,
    proof: VerifiedDammRealization
  ) {
    assertDammRealization(proof);
    if (proof.source === 'audit')
      throw new Error('Audit proofs cannot reserve financial execution');
    return this.tx(async (client) => {
      const raw = await this.loadFundingPlan(client, network, mint, events, false, sourceKind);
      if (raw.realization) return this.saveFundingPlan(client, network, mint, raw);
      const accounted = await this.accountedDamm(client, network, mint, raw.pool);
      if (
        !raw.migrated ||
        raw.events.some((event) => event.phase !== 1) ||
        proof.networkGenesis !== network ||
        proof.mint !== mint ||
        proof.pool !== raw.pool ||
        proof.rawExpected !== raw.lamports ||
        proof.realizedNet <= 0n ||
        proof.shortfall !== proof.externalLpExcluded + proof.roundingLoss ||
        (proof.eventIds as EventId[]).map(feeEventKey).sort().join(',') !==
          raw.events
            .map((event) => feeEventKey(event.id))
            .sort()
            .join(',') ||
        proof.rawExpected !== proof.realizedNet + proof.shortfall ||
        proof.source !== (sourceKind === 'collected_allocation' ? 'collected' : 'position') ||
        String(proof.accountedRealizedNet) !== accounted.accountedRealizedNet.toString() ||
        String(proof.accountedExternalLpExcluded) !==
          accounted.accountedExternalLpExcluded.toString() ||
        String(proof.accountedRoundingLoss) !== accounted.accountedRoundingLoss.toString()
      )
        throw new Error(
          'Realization proof does not match the immutable raw fee set and settled custody'
        );
      const rawCommitment = raw.commitment,
        commitment = realizedFundingCommitment(
          rawCommitment,
          proof.realizedNet,
          proof.shortfall,
          proof.digest
        );
      await recordFinalizedDammWindows(client, proof);
      await client.query(
        `INSERT INTO financial_funding_realizations(network_genesis,mint,raw_commitment,realized_commitment,raw_expected,
        realized_net,shortfall,external_lp_excluded,rounding_loss,proof_digest,proof,finalized_slot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          network,
          mint,
          rawCommitment,
          commitment,
          proof.rawExpected.toString(),
          proof.realizedNet.toString(),
          proof.shortfall.toString(),
          proof.externalLpExcluded.toString(),
          proof.roundingLoss.toString(),
          proof.digest,
          JSON.stringify(proof, (_key, value) =>
            typeof value === 'bigint' ? value.toString() : value
          ),
          proof.slot,
        ]
      );
      const realized = await this.loadFundingPlan(client, network, mint, events, false, sourceKind);
      return this.saveFundingPlan(client, network, mint, realized);
    });
  }

  async normalizeZeroFees(
    network: string,
    mint: string,
    events: EventId[],
    sourceKind: FundingSourceKind,
    proof: VerifiedDammRealization
  ) {
    assertDammRealization(proof);
    if (proof.source === 'audit' || proof.realizedNet !== 0n || proof.zeroCash !== true)
      throw new Error('A proved zero-owned-cash event set is required');
    return this.tx(async (client) => {
      const raw = await this.loadFundingPlan(client, network, mint, events, true, sourceKind);
      if (
        !raw.migrated ||
        raw.realization ||
        raw.events.some((event) => event.phase !== 1) ||
        proof.networkGenesis !== network ||
        proof.mint !== mint ||
        proof.pool !== raw.pool ||
        proof.rawExpected !== raw.lamports ||
        (proof.eventIds as EventId[]).map(feeEventKey).sort().join(',') !==
          raw.events
            .map((event) => feeEventKey(event.id))
            .sort()
            .join(',') ||
        proof.source !== (sourceKind === 'collected_allocation' ? 'collected' : 'position')
      )
        throw new Error('Zero-cash proof differs from the immutable raw fee set');
      await recordFinalizedDammWindows(client, proof);
      let normalized = 0;
      for (const event of raw.events) {
        const id = event.id;
        const funded = await client.query(
          `SELECT signature FROM financial_funded_events WHERE network_genesis=$1 AND signature=$2
          AND instruction_index=$3 AND event_index=$4`,
          [network, id.signature, id.instructionIndex, id.eventIndex]
        );
        if (funded.rows.length) throw new Error('Funded event cannot be reclassified as zero-cash');
        const reserved = await client.query(
          `SELECT signature FROM financial_planned_fee_events WHERE network_genesis=$1
          AND signature=$2 AND instruction_index=$3 AND event_index=$4`,
          [network, id.signature, id.instructionIndex, id.eventIndex]
        );
        if (reserved.rows.length)
          throw new Error('Reserved fee intent must be reconciled before zero-cash normalization');
        const result = await client.query(
          `INSERT INTO financial_zero_fee_events(network_genesis,mint,signature,instruction_index,event_index,raw_expected,
          proof_digest,proof,finalized_slot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING signature`,
          [
            network,
            mint,
            id.signature,
            id.instructionIndex,
            id.eventIndex,
            event.net.toString(),
            proof.digest,
            JSON.stringify(proof, (_key, value) =>
              typeof value === 'bigint' ? value.toString() : value
            ),
            proof.slot,
          ]
        );
        normalized += result.rows.length;
      }
      return {
        normalizedZero: true as const,
        eventsNormalized: normalized,
        rawObserved: raw.lamports,
        proofDigest: proof.digest,
        transactionsSigned: false,
        transactionsSent: false,
      };
    });
  }

  private async saveFundingPlan(
    client: PoolClient,
    network: string,
    mint: string,
    plan: FundingPlan
  ): Promise<FundingPlan> {
    const existing = (
      await client.query<{ source_kind: FundingSourceKind; status: string }>(
        `SELECT source_kind,status FROM financial_funding_plans
        WHERE network_genesis=$1 AND mint=$2 AND commitment=$3 FOR UPDATE`,
        [network, mint, plan.commitment]
      )
    ).rows[0];
    if (existing) {
      if (existing.source_kind !== plan.sourceKind || existing.status !== 'prepared')
        throw new Error('Funding intent is already finalized or conflicts');
      return plan;
    }
    if (plan.migrated && !plan.realization)
      throw new Error('Finalized LP realization proof is required before reserving DAMM fees');
    await client.query(
      `INSERT INTO financial_funding_plans(network_genesis,mint,commitment,source_kind) VALUES($1,$2,$3,$4)`,
      [network, mint, plan.commitment, plan.sourceKind]
    );
    for (const event of plan.events)
      await client.query(
        `INSERT INTO financial_planned_fee_events(network_genesis,mint,
        signature,instruction_index,event_index,commitment) VALUES($1,$2,$3,$4,$5,$6)`,
        [
          network,
          mint,
          event.id.signature,
          event.id.instructionIndex,
          event.id.eventIndex,
          plan.commitment,
        ]
      );
    return plan;
  }

  async ingestFinalizedFees(events: VerifiedFeeEvent[]): Promise<number> {
    const checked = new Set<string>();
    for (const event of events) {
      assertVerifiedFee(event);
      const key = `${event.networkGenesis}:${event.mint}:${event.pool}`;
      if (
        !checked.has(key) &&
        !(await this.verifyPool(event.networkGenesis, event.mint, event.pool))
      )
        throw new Error('Pool is not a verified financial pool');
      checked.add(key);
    }
    return this.tx(async (client) => {
      let inserted = 0;
      for (const event of events) {
        assertVerifiedFee(event);
        const coin = await this.coin(client, event.networkGenesis, event.mint);
        if (
          event.pool !== coin.dbc_pool &&
          !(
            await client.query(
              `SELECT 1 FROM launch_migrations WHERE
          network_genesis=$1 AND mint=$2 AND damm_pool=$3`,
              [event.networkGenesis, event.mint, event.pool]
            )
          ).rowCount
        )
          throw new Error('Finalized migrated pool mapping is missing');
        const phase =
          event.pool === coin.dbc_pool
            ? event.tradeTime < Number(coin.activation_point) + 27
              ? 0
              : 1
            : 1;
        if (event.phase !== phase)
          throw new Error('Executed event phase differs from its verified route');
        const previous = await this.phase(client, event.networkGenesis, event.mint, phase);
        const allocation = allocateExecutedFee({
          total: event.total,
          protocol: event.allocation.protocol,
          referral: event.allocation.referral,
          activationTime: Number(coin.activation_point),
          tradeTime: event.tradeTime,
          mode: coin.mode,
          previousPhaseNet: BigInt(previous.observed_net),
          phase: phase === 0 ? 'rinse' : 'post',
        });
        const values = bucketValues(allocation);
        const row = await client.query(
          `INSERT INTO financial_fee_events(network_genesis,mint,signature,
          instruction_index,event_index,finalized_slot,trade_time,pool,event_digest,total,protocol,referral,
          rinse_buyback,creator,community,platform,phase) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
          ON CONFLICT DO NOTHING RETURNING event_digest`,
          [
            event.networkGenesis,
            event.mint,
            event.signature,
            event.instructionIndex,
            event.eventIndex,
            event.finalizedSlot,
            event.tradeTime,
            event.pool,
            event.eventDigest,
            event.total.toString(),
            allocation.protocol.toString(),
            allocation.referral.toString(),
            ...values.map(String),
            phase,
          ]
        );
        if (!row.rowCount) {
          const saved = (
            await client.query<{ event_digest: string }>(
              `SELECT event_digest FROM financial_fee_events
            WHERE network_genesis=$1 AND signature=$2 AND instruction_index=$3 AND event_index=$4`,
              [event.networkGenesis, event.signature, event.instructionIndex, event.eventIndex]
            )
          ).rows[0];
          if (saved?.event_digest !== event.eventDigest)
            throw new Error('Finalized fee identity conflict');
          continue;
        }
        await client.query(
          `UPDATE financial_phase_totals SET observed_net=observed_net+$4 WHERE network_genesis=$1
          AND mint=$2 AND phase=$3`,
          [
            event.networkGenesis,
            event.mint,
            phase,
            (event.total - allocation.protocol - allocation.referral).toString(),
          ]
        );
        for (let i = 0; i < buckets.length; i++) {
          await this.balance(client, event.networkGenesis, event.mint, buckets[i]!);
          await client.query(
            `UPDATE financial_balances SET accrued=accrued+$4
            WHERE network_genesis=$1 AND mint=$2 AND bucket=$3`,
            [event.networkGenesis, event.mint, buckets[i], values[i]!.toString()]
          );
        }
        inserted++;
      }
      return inserted;
    });
  }

  /** Bind one actual program-vault deposit to an exact, previously unfunded set of executed fees. */
  async recordVerifiedFunding(input: {
    evidence: FinalizedEvidence;
    mint: string;
    vault: string;
    events: EventId[];
    receipt: VerifiedFundingReceipt;
    sourceKind?: FundingSourceKind;
    unwrapAccount?: string;
    sourceQuoteVault?: string;
    instruction: { accounts: string[]; data: Uint8Array; instructionIndex: number };
  }) {
    assertFinalizedEvidence(input.evidence);
    assertFundingReceipt(input.receipt);
    const network = input.evidence.networkGenesis;
    return this.tx(async (client) => {
      await this.coin(client, network, input.mint);
      if (!this.vaultProgram) throw new Error('Reviewed vault program is not configured');
      const plan = await this.loadFundingPlan(
        client,
        network,
        input.mint,
        input.events,
        true,
        input.sourceKind
      );
      const { commitment, lamports } = plan;
      if (
        input.receipt.networkGenesis !== network ||
        input.receipt.signature !== input.evidence.signature ||
        input.receipt.messageDigest !== input.evidence.messageDigest ||
        input.receipt.mint !== input.mint ||
        input.receipt.commitment !== commitment ||
        input.receipt.total !== lamports
      )
        throw new Error(
          'Program funding receipt differs from the finalized earning-period allocation'
        );
      const reserved = (
        await client.query<{ source_kind: FundingSourceKind }>(
          `SELECT source_kind FROM financial_funding_plans
        WHERE network_genesis=$1 AND mint=$2 AND commitment=$3 FOR UPDATE`,
          [network, input.mint, plan.commitment]
        )
      ).rows[0];
      if (!reserved || reserved.source_kind !== plan.sourceKind)
        throw new Error('Funding event set was not durably reserved before execution');
      const totals = buckets.map((bucket) => plan.allocation[bucket]);
      const ids = plan.events.map((event) => event.id);
      const payload = encodeFundingPlan(plan);
      // Strict ABI binding: neither the phase vector nor its per-event rounding can be reassigned.
      if (!Buffer.from(input.instruction.data).equals(payload))
        throw new Error('Funding instruction must commit to the executed fee allocation');
      const vault = PublicKey.findProgramAddressSync(
        [Buffer.from('coin'), new PublicKey(input.mint).toBuffer()],
        new PublicKey(this.vaultProgram)
      )[0];
      const funding = PublicKey.findProgramAddressSync(
        [Buffer.from('funding'), vault.toBuffer(), Buffer.from(plan.fundingId, 'hex')],
        new PublicKey(this.vaultProgram)
      )[0];
      if (
        vault.toBase58() !== input.vault ||
        input.instruction.accounts[2] !== input.vault ||
        input.instruction.accounts[3] !== funding.toBase58() ||
        (plan.sourceKind !== 'collected_allocation' &&
          input.instruction.accounts[4] !== input.unwrapAccount)
      )
        throw new Error('Funding does not use the canonical coin vault and receipt accounts');
      const ix = requireInstruction(input.evidence, {
        program: this.vaultProgram,
        ...input.instruction,
      });
      const fundingTags = [
        Buffer.from(discriminators.collect_fees),
        Buffer.from(discriminators.collect_damm_fees),
        createHash('sha256').update('global:allocate_collected_fees').digest().subarray(0, 8),
      ];
      if (
        allInstructions(input.evidence).filter(
          (action) =>
            action.program === this.vaultProgram &&
            fundingTags.some((tag) => action.data.subarray(0, 8).equals(tag))
        ).length !== 1
      )
        throw new Error(
          'A funding transaction must contain exactly one unambiguous vault funding action'
        );
      let collected = 0n;
      if (plan.sourceKind === 'collected_allocation') {
        if (lamportDelta(input.evidence, input.vault) !== 0n)
          throw new Error('Collected-fee allocation must not invent a native deposit');
      } else {
        if (!input.unwrapAccount || !input.sourceQuoteVault)
          throw new Error('Canonical native claim token accounts are required');
        if (
          input.sourceQuoteVault !== ix.accounts[15] ||
          input.unwrapAccount !== ix.accounts[13] ||
          plan.pool !== ix.accounts[plan.migrated ? 10 : 11]
        )
          throw new Error('DEX fee claim accounts differ from the verified canonical pool');
        const rent = closedNativeAccountRent(input.evidence, input.unwrapAccount, input.vault);
        collected = purchasedTokens(
          input.evidence,
          input.sourceQuoteVault,
          input.unwrapAccount,
          'So11111111111111111111111111111111111111112'
        );
        if (
          collected < lamports ||
          (plan.sourceKind === 'dbc_claim' && collected !== lamports) ||
          lamportDelta(input.evidence, input.vault) - rent < collected
        )
          throw new Error('Actual finalized DEX collection differs from executed fee funding');
      }
      const existing = (
        await client.query<{ commitment: string }>(
          `SELECT commitment FROM financial_funding
        WHERE network_genesis=$1 AND signature=$2 AND instruction_index=$3`,
          [network, input.evidence.signature, ix.instructionIndex]
        )
      ).rows[0];
      if (existing) {
        if (existing.commitment !== commitment) throw new Error('Funding receipt conflicts');
        return { commitment, lamports, inserted: false };
      }
      for (const phase of [0, 1] as const) {
        const prior = await this.phase(client, network, input.mint, phase);
        const expectedBefore =
          phase === 0 ? input.receipt.rinseNetBefore : input.receipt.postNetBefore;
        if (BigInt(prior.funded_net) !== expectedBefore)
          throw new Error('Earlier finalized funding receipts must be reconciled first');
      }
      await client.query(
        `INSERT INTO financial_collected_reserves(network_genesis,mint) VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [network, input.mint]
      );
      const reserve = (
        await client.query<{ lamports: string }>(
          `SELECT lamports FROM financial_collected_reserves
        WHERE network_genesis=$1 AND mint=$2 FOR UPDATE`,
          [network, input.mint]
        )
      ).rows[0]!;
      if (BigInt(reserve.lamports) + collected < lamports)
        throw new Error('No verified unallocated collection covers this allocation');
      await client.query(
        `INSERT INTO financial_funding(network_genesis,mint,signature,instruction_index,
        vault,finalized_slot,lamports,commitment,message_digest,source_kind,collected_lamports) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          network,
          input.mint,
          input.evidence.signature,
          ix.instructionIndex,
          input.vault,
          input.evidence.slot,
          lamports.toString(),
          commitment,
          input.evidence.messageDigest,
          plan.sourceKind,
          collected.toString(),
        ]
      );
      for (const id of ids)
        await client.query(
          `INSERT INTO financial_funded_events(network_genesis,signature,
        instruction_index,event_index,funding_signature,funding_instruction_index) VALUES($1,$2,$3,$4,$5,$6)`,
          [
            network,
            id.signature,
            id.instructionIndex,
            id.eventIndex,
            input.evidence.signature,
            ix.instructionIndex,
          ]
        );
      if (plan.realization)
        await client.query(
          `INSERT INTO financial_funding_rounding(network_genesis,mint,commitment,raw_expected,
        realized_net,shortfall,proof_digest,external_lp_excluded,rounding_loss) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            network,
            input.mint,
            commitment,
            plan.realization.rawExpected.toString(),
            plan.realization.realizedNet.toString(),
            plan.realization.shortfall.toString(),
            plan.realization.proofDigest,
            plan.realization.externalLpExcluded.toString(),
            plan.realization.roundingLoss.toString(),
          ]
        );
      for (let i = 0; i < buckets.length; i++)
        await client.query(
          `UPDATE financial_balances SET funded=funded+$4
        WHERE network_genesis=$1 AND mint=$2 AND bucket=$3`,
          [network, input.mint, buckets[i], totals[i]!.toString()]
        );
      for (const item of plan.phases)
        await client.query(
          `UPDATE financial_phase_totals SET funded_net=funded_net+$4
        WHERE network_genesis=$1 AND mint=$2 AND phase=$3`,
          [network, input.mint, item.phase, item.net.toString()]
        );
      await client.query(
        `UPDATE financial_collected_reserves SET lamports=lamports+$3-$4
        WHERE network_genesis=$1 AND mint=$2`,
        [network, input.mint, collected.toString(), lamports.toString()]
      );
      await client.query(
        `UPDATE financial_funding_plans SET status='finalized' WHERE network_genesis=$1 AND mint=$2 AND commitment=$3`,
        [network, input.mint, plan.commitment]
      );
      return { commitment, lamports, inserted: true };
    });
  }

  async createRewardEpoch(input: {
    networkGenesis: string;
    mint: string;
    epoch: number;
    snapshot: FinalizedHolderSnapshot;
  }) {
    assertHolderSnapshot(input.snapshot, input.networkGenesis, input.mint);
    return this.tx(async (client) => {
      const coin = await this.coin(client, input.networkGenesis, input.mint);
      if (
        coin.mode !== 'community' ||
        !Number.isSafeInteger(input.epoch) ||
        input.epoch < 0 ||
        Math.floor(input.snapshot.blockTime / 3600) !== input.epoch + 1 ||
        input.snapshot.blockTime % 3600 >= 60 ||
        input.snapshot.blockTime < Number(coin.activation_point) + 27
      )
        throw new Error('Invalid hourly Community snapshot');
      const existing = (
        await client.query<{ snapshot_digest: string }>(
          `SELECT snapshot_digest FROM financial_epochs
        WHERE network_genesis=$1 AND mint=$2 AND epoch=$3`,
          [input.networkGenesis, input.mint, input.epoch]
        )
      ).rows[0];
      if (existing) {
        if (existing.snapshot_digest !== input.snapshot.digest)
          throw new Error('Hourly allocation is immutable');
        return { inserted: false };
      }
      const balance = await this.balance(client, input.networkGenesis, input.mint, 'community');
      const latestFunding = (
        await client.query<{ slot: string | null }>(
          `SELECT max(finalized_slot) AS slot FROM financial_funding
        WHERE network_genesis=$1 AND mint=$2`,
          [input.networkGenesis, input.mint]
        )
      ).rows[0]?.slot;
      if (
        latestFunding !== null &&
        latestFunding !== undefined &&
        BigInt(latestFunding) > BigInt(input.snapshot.slot)
      )
        throw new Error('Snapshot predates the funded rewards being allocated');
      const budget = BigInt(balance.funded) - BigInt(balance.reserved) - BigInt(balance.spent);
      const result = allocateHolderSnapshot(budget, input.snapshot);
      const allocated = budget - result.carryForward;
      if (!this.vaultProgram) throw new Error('Reviewed vault program is not configured');
      const merkle = buildRewardMerkle(
        this.vaultProgram,
        input.mint,
        input.epoch,
        result.allocations
      );
      await client.query(
        `INSERT INTO financial_epochs(network_genesis,mint,epoch,snapshot_slot,snapshot_time,
        snapshot_digest,budget,allocated,carry,merkle_root) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          input.networkGenesis,
          input.mint,
          input.epoch,
          input.snapshot.slot,
          input.snapshot.blockTime,
          input.snapshot.digest,
          budget.toString(),
          allocated.toString(),
          result.carryForward.toString(),
          merkle.root,
        ]
      );
      for (const item of merkle.allocations)
        await client.query(
          `INSERT INTO financial_entitlements(
        network_genesis,mint,epoch,wallet,lamports,proof) VALUES($1,$2,$3,$4,$5,$6)`,
          [
            input.networkGenesis,
            input.mint,
            input.epoch,
            item.wallet,
            item.lamports.toString(),
            JSON.stringify(item.proof),
          ]
        );
      await client.query(
        `UPDATE financial_balances SET reserved=reserved+$3 WHERE network_genesis=$1
        AND mint=$2 AND bucket='community'`,
        [input.networkGenesis, input.mint, allocated.toString()]
      );
      return {
        inserted: true,
        budget,
        allocated,
        carry: result.carryForward,
        allocations: merkle.allocations,
        root: merkle.root,
      };
    });
  }

  async rewardEpoch(network: string, mint: string, epoch: number) {
    return this.tx(async (client) => {
      const saved = (
        await client.query<FinancialEpoch>(
          `SELECT * FROM financial_epochs WHERE network_genesis=$1
        AND mint=$2 AND epoch=$3`,
          [network, mint, epoch]
        )
      ).rows[0];
      if (!saved) return null;
      const rows = (
        await client.query<{ wallet: string; lamports: string }>(
          `SELECT wallet,lamports FROM financial_entitlements
        WHERE network_genesis=$1 AND mint=$2 AND epoch=$3 ORDER BY wallet`,
          [network, mint, epoch]
        )
      ).rows;
      const tree = buildRewardMerkle(
        this.vaultProgram,
        mint,
        epoch,
        rows.map((row) => ({ wallet: row.wallet, lamports: BigInt(row.lamports) }))
      );
      if (tree.root !== saved.merkle_root)
        throw new Error('Stored reward root does not match immutable allocations');
      return { ...saved, allocations: tree.allocations };
    });
  }

  async claimable(
    network: string,
    mint: string,
    wallet: string,
    options: { beforeEpoch?: number; epoch?: number; limit?: number } = {}
  ): Promise<ClaimableReward[]> {
    new PublicKey(wallet);
    for (const value of [options.beforeEpoch, options.epoch])
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
        throw new Error('Invalid reward epoch');
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Invalid reward page size');
    return this.tx(
      async (client) =>
        (
          await client.query<ClaimableReward>(
            `SELECT ent.epoch::text AS epoch,ent.wallet,ent.lamports,
      ent.proof,e.merkle_root,e.snapshot_slot,
      CASE WHEN j.status='finalized' THEN 'paid' WHEN j.id IS NOT NULL THEN 'pending' ELSE 'available' END AS status,
      j.id AS job_id,j.status AS job_status,j.signature
      FROM financial_entitlements ent JOIN financial_epochs e USING(network_genesis,mint,epoch)
      LEFT JOIN financial_jobs j ON j.network_genesis=ent.network_genesis AND j.mint=ent.mint AND
        j.epoch=ent.epoch AND j.recipient=ent.wallet AND j.kind='community_claim' AND j.status<>'failed'
      WHERE ent.network_genesis=$1 AND ent.mint=$2 AND ent.wallet=$3 AND e.status='funded'
        AND ($4::bigint IS NULL OR ent.epoch<$4) AND ($5::bigint IS NULL OR ent.epoch=$5)
      ORDER BY ent.epoch DESC LIMIT $6`,
            [network, mint, wallet, options.beforeEpoch ?? null, options.epoch ?? null, limit]
          )
        ).rows
    );
  }

  async pendingClaim(
    network: string,
    mint: string,
    wallet: string,
    epoch?: number
  ): Promise<FinancialJob | null> {
    return this.tx(
      async (client) =>
        (
          await client.query<FinancialJob>(
            `SELECT * FROM financial_jobs WHERE
      network_genesis=$1 AND mint=$2 AND recipient=$3 AND kind=$4 AND epoch IS NOT DISTINCT FROM $5
      AND status IN ('prepared','signed','submitted','manual_review') ORDER BY created_at DESC LIMIT 1`,
            [
              network,
              mint,
              wallet,
              epoch === undefined ? 'creator_claim' : 'community_claim',
              epoch ?? null,
            ]
          )
        ).rows[0] ?? null
    );
  }

  async pendingBuyback(network: string, mint: string): Promise<FinancialJob | null> {
    return this.tx(
      async (client) =>
        (
          await client.query<FinancialJob>(
            `SELECT * FROM financial_jobs WHERE
      network_genesis=$1 AND mint=$2 AND kind='buyback' AND status IN ('prepared','signed','submitted','manual_review')
      ORDER BY created_at LIMIT 1`,
            [network, mint]
          )
        ).rows[0] ?? null
    );
  }

  async recordVerifiedEpochFunding(input: {
    networkGenesis: string;
    mint: string;
    epoch: number;
    evidence: FinalizedEvidence;
    instruction: { accounts: string[]; data: Uint8Array };
  }) {
    assertFinalizedEvidence(input.evidence);
    if (input.evidence.networkGenesis !== input.networkGenesis)
      throw new Error('Epoch funding network mismatch');
    return this.tx(async (client) => {
      const row = (
        await client.query<FinancialEpoch>(
          `SELECT * FROM financial_epochs WHERE network_genesis=$1
        AND mint=$2 AND epoch=$3 FOR UPDATE`,
          [input.networkGenesis, input.mint, input.epoch]
        )
      ).rows[0];
      if (!row || BigInt(row.allocated) <= 0n || input.evidence.slot < Number(row.snapshot_slot))
        throw new Error('Funded epoch allocation is missing or not finalized');
      if (row.status === 'funded') {
        if (row.funding_signature !== input.evidence.signature)
          throw new Error('Epoch was already funded by another transaction');
        return row;
      }
      const program = new PublicKey(this.vaultProgram),
        { coin, settings } = vaultAddresses(program, new PublicKey(input.mint));
      const epoch = epochAddress(program, coin, BigInt(input.epoch));
      const data = Buffer.concat([
        Buffer.from(discriminators.create_epoch),
        u64(BigInt(input.epoch)),
        digest32(row.merkle_root),
        u64(BigInt(row.snapshot_slot)),
        digest32(row.snapshot_digest),
        u64(BigInt(row.allocated)),
      ]);
      if (
        !data.equals(Buffer.from(input.instruction.data)) ||
        input.instruction.accounts.length !== 5 ||
        input.instruction.accounts[1] !== settings.toBase58() ||
        input.instruction.accounts[2] !== coin.toBase58() ||
        input.instruction.accounts[3] !== epoch.toBase58() ||
        input.instruction.accounts[4] !== PublicKey.default.toBase58()
      )
        throw new Error('Epoch instruction differs from funded allocation');
      requireInstruction(input.evidence, { program: this.vaultProgram, ...input.instruction });
      const account = await readEvidenceAccount(input.evidence, epoch),
        state = account?.data;
      if (
        !account?.owner.equals(program) ||
        !state ||
        state.length !== 138 ||
        state.subarray(0, 8).toString() !== 'REPOCH01' ||
        state[8] !== 1 ||
        !state.subarray(10, 42).equals(coin.toBuffer()) ||
        state.readBigUInt64LE(42) !== BigInt(input.epoch) ||
        state.subarray(50, 82).toString('hex') !== row.merkle_root ||
        state.readBigUInt64LE(82) !== BigInt(row.snapshot_slot) ||
        state.subarray(90, 122).toString('hex') !== row.snapshot_digest ||
        state.readBigUInt64LE(122) !== BigInt(row.allocated) ||
        state.readBigUInt64LE(130) > BigInt(row.allocated)
      )
        throw new Error('Immutable finalized epoch custody does not match the allocation');
      if (
        lamportDelta(input.evidence, coin.toBase58()) !== -BigInt(row.allocated) ||
        lamportDelta(input.evidence, epoch.toBase58()) < BigInt(row.allocated)
      )
        throw new Error('Finalized epoch funding is insufficient');
      return (
        await client.query<FinancialEpoch>(
          `UPDATE financial_epochs SET status='funded',funding_signature=$4,
        funding_slot=$5 WHERE network_genesis=$1 AND mint=$2 AND epoch=$3 RETURNING *`,
          [
            input.networkGenesis,
            input.mint,
            input.epoch,
            input.evidence.signature,
            input.evidence.slot,
          ]
        )
      ).rows[0]!;
    });
  }

  async prepareExecution(input: PreparedExecution): Promise<FinancialJob> {
    assertFinalizedClock(input.clock);
    if (input.clock.networkGenesis !== input.networkGenesis)
      throw new Error('Execution clock network mismatch');
    if (
      !this.vaultProgram ||
      input.expectation.program !== this.vaultProgram ||
      !Number.isSafeInteger(input.lastValidBlockHeight) ||
      input.lastValidBlockHeight < 0 ||
      input.transactionBase64.length > 1644
    )
      throw new Error('A reviewed bounded vault execution is required');
    const bytes = Buffer.from(input.transactionBase64, 'base64');
    if (bytes.length > 1232) throw new Error('Execution transaction is too large');
    const transaction = VersionedTransaction.deserialize(bytes);
    if (transaction.signatures.some((signature) => signature.some((byte) => byte !== 0)))
      throw new Error('Prepare an unsigned execution before attaching any external signature');
    const plannedInstructions = transaction.message.compiledInstructions.map((ix) => ({
      program: transaction.message.staticAccountKeys[ix.programIdIndex]?.toBase58(),
      accounts: ix.accountKeyIndexes.map((index) =>
        transaction.message.staticAccountKeys[index]?.toBase58()
      ),
      data: Buffer.from(ix.data),
    }));
    const matching = plannedInstructions.filter(
      (ix) =>
        ix.program === input.expectation.program &&
        ix.data.equals(Buffer.from(input.expectation.dataBase64, 'base64')) &&
        ix.accounts.length === input.expectation.accounts.length &&
        ix.accounts.every((address, index) => address === input.expectation.accounts[index])
    );
    if (
      matching.length !== 1 ||
      plannedInstructions.some(
        (ix) => ix !== matching[0] && ix.program !== ComputeBudgetProgram.programId.toBase58()
      )
    )
      throw new Error(
        'Execution must contain exactly the reviewed vault instruction and optional compute budget instructions'
      );
    const hash = messageDigest(transaction.message.serialize());
    const id = randomUUID();
    return this.tx(async (client) => {
      const coin = await this.coin(client, input.networkGenesis, input.mint);
      if (['creator_claim', 'community_claim', 'platform_claim'].includes(input.kind)) {
        if (input.expectation.effect !== 'sol_claim')
          throw new Error('Claims must use the reviewed SOL payout effect');
        const active = (
          await client.query<FinancialJob>(
            `SELECT * FROM financial_jobs WHERE network_genesis=$1
          AND mint=$2 AND kind=$3 AND recipient=$4 AND epoch IS NOT DISTINCT FROM $5
          AND status IN ('prepared','signed','submitted','manual_review') FOR UPDATE`,
            [input.networkGenesis, input.mint, input.kind, input.recipient, input.epoch ?? null]
          )
        ).rows[0];
        if (active) return active;
      }
      if (input.kind === 'buyback') {
        const active = (
          await client.query<FinancialJob>(
            `SELECT * FROM financial_jobs WHERE network_genesis=$1
          AND mint=$2 AND kind='buyback' AND status IN ('prepared','signed','submitted','manual_review') FOR UPDATE`,
            [input.networkGenesis, input.mint]
          )
        ).rows[0];
        if (active) return active;
      }
      const addresses = vaultAddresses(new PublicKey(this.vaultProgram), new PublicKey(input.mint));
      const payoutVault =
        input.kind === 'community_claim' && input.epoch !== undefined
          ? epochAddress(new PublicKey(this.vaultProgram), addresses.coin, BigInt(input.epoch))
          : addresses.coin;
      if (input.expectation.vault !== payoutVault.toBase58())
        throw new Error('Execution does not use the canonical coin or epoch vault');
      if (input.kind === 'buyback') {
        const data = Buffer.from(input.expectation.dataBase64, 'base64');
        if (
          input.expectation.effect !== 'buyback_burn' ||
          data.length < 43 ||
          !data.subarray(0, 8).equals(Buffer.from(discriminators.execute_buyback_burn)) ||
          data.readBigUInt64LE(16) !== input.lamports ||
          data.readBigUInt64LE(24) !== BigInt(input.expectation.minTokens ?? '0') ||
          data.readBigUInt64LE(24) <= 0n ||
          data.readBigInt64LE(32) < BigInt(input.clock.blockTime) ||
          data.readBigInt64LE(32) > BigInt(input.clock.blockTime + 120) ||
          input.expectation.tokenAccount !== addresses.tokenAccount.toBase58()
        )
          throw new Error(
            'Buyback amount, token accounts, output limit or deadline differs from reviewed policy'
          );
      }
      if (input.kind === 'burn')
        throw new Error('Standalone burns are disabled; use the atomic buyback/burn instruction');
      if (input.kind === 'buyback' && input.clock.blockTime < Number(coin.activation_point) + 27)
        throw new Error('Buybacks cannot execute before RINSE ends');
      const existing = (
        await client.query<FinancialJob>(
          `SELECT * FROM financial_jobs WHERE network_genesis=$1
        AND mint=$2 AND kind=$3 AND intent_key=$4 FOR UPDATE`,
          [input.networkGenesis, input.mint, input.kind, input.intentKey]
        )
      ).rows[0];
      if (existing) {
        if (existing.message_digest !== hash)
          throw new Error('Execution intent is already reserved with another message');
        return existing;
      }
      const bucket = expectedBucket(input.kind);
      if (
        input.kind === 'creator_claim' &&
        (coin.mode !== 'creator' || input.recipient !== coin.original_deployer)
      )
        throw new Error('Creator rewards belong to the immutable original deployer');
      if (input.kind === 'community_claim') {
        if (coin.mode !== 'community' || !Number.isSafeInteger(input.epoch))
          throw new Error('Invalid Community claim');
        const entitlement = (
          await client.query<{ lamports: string; proof: string[] }>(
            `SELECT ent.lamports,ent.proof FROM financial_entitlements ent
          JOIN financial_epochs e USING(network_genesis,mint,epoch)
          WHERE ent.network_genesis=$1 AND ent.mint=$2 AND ent.epoch=$3 AND ent.wallet=$4 AND e.status='funded' FOR SHARE`,
            [input.networkGenesis, input.mint, input.epoch, input.recipient]
          )
        ).rows[0];
        if (!entitlement || BigInt(entitlement.lamports) !== input.lamports)
          throw new Error('No matching funded entitlement');
        const instruction = claimCommunityInstruction({
          programId: new PublicKey(this.vaultProgram),
          mint: new PublicKey(input.mint),
          wallet: new PublicKey(input.recipient!),
          epoch: BigInt(input.epoch!),
          amount: input.lamports,
          proof: entitlement.proof,
        });
        if (
          !instruction.data.equals(Buffer.from(input.expectation.dataBase64, 'base64')) ||
          instruction.keys.map((key) => key.pubkey.toBase58()).join(',') !==
            input.expectation.accounts.join(',')
        )
          throw new Error('Claim instruction differs from funded owner entitlement');
      } else if (bucket) {
        if (input.kind === 'platform_claim') {
          const config = (
            await client.query<{ expected_leftover_receiver: string }>(
              `SELECT expected_leftover_receiver FROM launch_configs
            WHERE network_genesis=$1 AND config_key=$2`,
              [input.networkGenesis, coin.config_key]
            )
          ).rows[0];
          if (
            !config ||
            input.recipient !== config.expected_leftover_receiver ||
            transaction.message.staticAccountKeys[0]?.toBase58() !==
              config.expected_leftover_receiver
          )
            throw new Error('Platform payout belongs to the immutable reviewed treasury');
          const instruction = claimPlatformInstruction(
            new PublicKey(this.vaultProgram),
            new PublicKey(input.mint),
            new PublicKey(config.expected_leftover_receiver),
            input.lamports
          );
          if (
            !instruction.data.equals(Buffer.from(input.expectation.dataBase64, 'base64')) ||
            instruction.keys.map((key) => key.pubkey.toBase58()).join(',') !==
              input.expectation.accounts.join(',')
          )
            throw new Error(
              'Platform claim instruction differs from immutable treasury entitlement'
            );
        }
        if (input.kind === 'creator_claim') {
          const instruction = claimCreatorInstruction(
            new PublicKey(this.vaultProgram),
            new PublicKey(input.mint),
            new PublicKey(input.recipient!),
            input.lamports
          );
          if (
            !instruction.data.equals(Buffer.from(input.expectation.dataBase64, 'base64')) ||
            instruction.keys.map((key) => key.pubkey.toBase58()).join(',') !==
              input.expectation.accounts.join(',')
          )
            throw new Error('Claim instruction differs from immutable deployer entitlement');
        }
        const balance = await this.balance(client, input.networkGenesis, input.mint, bucket);
        if (
          input.lamports <= 0n ||
          input.lamports > BigInt(balance.funded) - BigInt(balance.spent) - BigInt(balance.reserved)
        )
          throw new Error('Insufficient verified funded balance');
        await client.query(
          `UPDATE financial_balances SET reserved=reserved+$4
          WHERE network_genesis=$1 AND mint=$2 AND bucket=$3`,
          [input.networkGenesis, input.mint, bucket, input.lamports.toString()]
        );
      } else {
        const parent = (
          await client.query<FinancialJob>('SELECT * FROM financial_jobs WHERE id=$1 FOR UPDATE', [
            input.parentJob,
          ])
        ).rows[0];
        if (
          !parent ||
          parent.kind !== 'buyback' ||
          parent.status !== 'finalized' ||
          parent.network_genesis !== input.networkGenesis ||
          parent.mint !== input.mint ||
          parent.expectations.effect === 'buyback_burn' ||
          BigInt(parent.received_tokens) !== input.tokens
        )
          throw new Error('Burn only the actual purchased tokens of a finalized buyback');
      }
      return (
        await client.query<FinancialJob>(
          `INSERT INTO financial_jobs(id,network_genesis,mint,intent_key,
        kind,bucket,lamports,tokens,recipient,epoch,parent_job,message_digest,transaction_base64,
        expectations,last_valid_block_height) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
          [
            id,
            input.networkGenesis,
            input.mint,
            input.intentKey,
            input.kind,
            bucket,
            input.lamports.toString(),
            (input.tokens ?? 0n).toString(),
            input.recipient ?? null,
            input.epoch ?? null,
            input.parentJob ?? null,
            hash,
            input.transactionBase64,
            JSON.stringify(input.expectation),
            input.lastValidBlockHeight,
          ]
        )
      ).rows[0]!;
    });
  }

  async prepareClaim(input: PreparedExecution): Promise<FinancialJob> {
    if (!['creator_claim', 'community_claim'].includes(input.kind))
      throw new Error('Expected a user claim');
    return this.prepareExecution(input);
  }

  async job(id: string): Promise<FinancialJob | null> {
    return this.tx(
      async (client) =>
        (await client.query<FinancialJob>('SELECT * FROM financial_jobs WHERE id=$1', [id]))
          .rows[0] ?? null
    );
  }
  async attachSignedTransaction(id: string, base64: string): Promise<FinancialJob> {
    return this.tx(async (client) => {
      const job = (
        await client.query<FinancialJob>('SELECT * FROM financial_jobs WHERE id=$1 FOR UPDATE', [
          id,
        ])
      ).rows[0];
      if (!job) throw new Error('Execution does not exist');
      const signed = validateSignedTransaction(base64, job.message_digest);
      if (job.signature) {
        if (job.signature !== signed.signature)
          throw new Error('Execution already has another signature');
        return job;
      }
      if (job.status !== 'prepared') throw new Error('Execution is not awaiting signatures');
      return (
        await client.query<FinancialJob>(
          `UPDATE financial_jobs SET signature=$2,transaction_base64=$3,
        status='signed',updated_at=now() WHERE id=$1 RETURNING *`,
          [id, signed.signature, base64]
        )
      ).rows[0]!;
    });
  }
  async markSubmitted(id: string): Promise<FinancialJob> {
    return this.tx(async (client) => {
      const job = (
        await client.query<FinancialJob>('SELECT * FROM financial_jobs WHERE id=$1 FOR UPDATE', [
          id,
        ])
      ).rows[0];
      if (!job?.signature || !['signed', 'submitted'].includes(job.status))
        throw new Error('Execution is not relayable');
      if (job.status === 'submitted') return job;
      return (
        await client.query<FinancialJob>(
          `UPDATE financial_jobs SET status='submitted',updated_at=now()
        WHERE id=$1 RETURNING *`,
          [id]
        )
      ).rows[0]!;
    });
  }
  async markUncertain(id: string): Promise<void> {
    await this.tx(async (client) => {
      await client.query(
        `UPDATE financial_jobs SET status='manual_review',updated_at=now()
      WHERE id=$1 AND status IN ('signed','submitted')`,
        [id]
      );
    });
  }

  async recordFinalizedFailure(id: string, proof: FinalizedFailure): Promise<FinancialJob> {
    assertFinalizedFailure(proof);
    return this.tx(async (client) => {
      const job = (
        await client.query<FinancialJob>('SELECT * FROM financial_jobs WHERE id=$1 FOR UPDATE', [
          id,
        ])
      ).rows[0];
      if (
        !job ||
        job.network_genesis !== proof.networkGenesis ||
        job.signature !== proof.signature ||
        job.message_digest !== proof.messageDigest ||
        job.status === 'finalized'
      )
        throw new Error('Failure proof does not belong to this execution');
      if (job.status === 'failed') return job;
      if (job.bucket && job.kind !== 'community_claim')
        await client.query(
          `UPDATE financial_balances SET reserved=reserved-$4
        WHERE network_genesis=$1 AND mint=$2 AND bucket=$3`,
          [job.network_genesis, job.mint, job.bucket, job.lamports]
        );
      return (
        await client.query<FinancialJob>(
          `UPDATE financial_jobs SET status='failed',finalized_slot=$2,updated_at=now()
        WHERE id=$1 RETURNING *`,
          [id, proof.slot]
        )
      ).rows[0]!;
    });
  }

  async cancelUnsignedBuyback(id: string, proof: UnsignedBuybackExpiry): Promise<FinancialJob> {
    assertUnsignedBuybackExpiry(proof);
    return this.tx(async (client) => {
      const job = (
        await client.query<FinancialJob>('SELECT * FROM financial_jobs WHERE id=$1 FOR UPDATE', [
          id,
        ])
      ).rows[0];
      if (
        !job ||
        job.id !== proof.jobId ||
        job.network_genesis !== proof.networkGenesis ||
        job.mint !== proof.mint ||
        this.vaultProgram !== proof.program ||
        job.message_digest !== proof.messageDigest ||
        job.signature ||
        job.kind !== 'buyback' ||
        job.last_valid_block_height !== proof.lastValidBlockHeight
      )
        throw new Error('Expiry proof does not belong to this unsigned buyback');
      if (job.status === 'failed') return job;
      if (
        job.status !== 'prepared' ||
        BigInt(proof.finalizedHeight) <= BigInt(job.last_valid_block_height) ||
        Buffer.from(job.expectations.dataBase64, 'base64').readBigUInt64LE(8) !== proof.nonce
      )
        throw new Error('Buyback is not renewable');
      const balance = await this.balance(client, job.network_genesis, job.mint, 'rinse_buyback');
      if (BigInt(balance.funded) - BigInt(balance.spent) !== proof.buybackBudget)
        throw new Error(
          'Actual buyback custody differs from the journal; reconcile before renewal'
        );
      await client.query(
        `UPDATE financial_balances SET reserved=reserved-$3 WHERE network_genesis=$1
        AND mint=$2 AND bucket='rinse_buyback'`,
        [job.network_genesis, job.mint, job.lamports]
      );
      return (
        await client.query<FinancialJob>(
          `UPDATE financial_jobs SET status='failed',updated_at=now()
        WHERE id=$1 RETURNING *`,
          [id]
        )
      ).rows[0]!;
    });
  }

  async cancelUnsignedClaim(id: string, proof: UnsignedClaimExpiry): Promise<FinancialJob> {
    assertUnsignedClaimExpiry(proof);
    return this.tx(async (client) => {
      const job = (
        await client.query<FinancialJob>('SELECT * FROM financial_jobs WHERE id=$1 FOR UPDATE', [
          id,
        ])
      ).rows[0];
      if (
        !job ||
        job.id !== proof.jobId ||
        job.network_genesis !== proof.networkGenesis ||
        job.mint !== proof.mint ||
        this.vaultProgram !== proof.program ||
        job.message_digest !== proof.messageDigest ||
        job.last_valid_block_height !== proof.lastValidBlockHeight ||
        job.signature ||
        !['creator_claim', 'community_claim', 'platform_claim'].includes(job.kind)
      )
        throw new Error('Expiry proof does not belong to this unsigned claim');
      if (job.status === 'failed') return job;
      if (
        job.status !== 'prepared' ||
        BigInt(proof.finalizedHeight) <= BigInt(job.last_valid_block_height)
      )
        throw new Error('Claim is not renewable');
      if (job.kind === 'creator_claim' || job.kind === 'platform_claim') {
        const bucket = job.kind === 'creator_claim' ? 'creator' : 'platform';
        const balance = await this.balance(client, job.network_genesis, job.mint, bucket);
        if (
          BigInt(balance.funded) - BigInt(balance.spent) !==
          (bucket === 'creator' ? proof.creatorBudget : proof.platformBudget)
        )
          throw new Error(
            'Actual creator custody differs from the journal; reconcile receipts before renewal'
          );
        await client.query(
          `UPDATE financial_balances SET reserved=reserved-$3 WHERE network_genesis=$1
          AND mint=$2 AND bucket=$4`,
          [job.network_genesis, job.mint, job.lamports, bucket]
        );
      }
      return (
        await client.query<FinancialJob>(
          `UPDATE financial_jobs SET status='failed',updated_at=now()
        WHERE id=$1 RETURNING *`,
          [id]
        )
      ).rows[0]!;
    });
  }

  async renewExpiredCommunityClaim(
    id: string,
    proof: CommunityClaimRenewal
  ): Promise<FinancialJob> {
    assertCommunityClaimRenewal(proof);
    return this.tx(async (client) => {
      const job = (
        await client.query<FinancialJob>('SELECT * FROM financial_jobs WHERE id=$1 FOR UPDATE', [
          id,
        ])
      ).rows[0];
      if (
        !job ||
        job.id !== proof.jobId ||
        job.network_genesis !== proof.networkGenesis ||
        job.mint !== proof.mint ||
        this.vaultProgram !== proof.program ||
        job.kind !== 'community_claim' ||
        job.signature !== proof.oldSignature ||
        job.message_digest !== proof.oldDigest ||
        job.last_valid_block_height !== proof.oldLastValidHeight ||
        !['signed', 'submitted', 'manual_review'].includes(job.status) ||
        job.epoch === null ||
        !job.recipient
      )
        throw new Error('Signed Community state changed during renewal');
      const entitlement = (
        await client.query<{ lamports: string; proof: string[]; merkle_root: string }>(
          `SELECT ent.lamports,ent.proof,e.merkle_root
        FROM financial_entitlements ent JOIN financial_epochs e USING(network_genesis,mint,epoch)
        WHERE ent.network_genesis=$1 AND ent.mint=$2 AND ent.epoch=$3 AND ent.wallet=$4 AND e.status='funded' FOR SHARE`,
          [job.network_genesis, job.mint, job.epoch, job.recipient]
        )
      ).rows[0];
      if (
        !entitlement ||
        BigInt(entitlement.lamports) !== BigInt(job.lamports) ||
        entitlement.merkle_root !== proof.epochRoot
      )
        throw new Error('Immutable funded entitlement changed during Community renewal');
      const instruction = claimCommunityInstruction({
        programId: new PublicKey(this.vaultProgram),
        mint: new PublicKey(job.mint),
        wallet: new PublicKey(job.recipient),
        epoch: BigInt(job.epoch),
        amount: BigInt(job.lamports),
        proof: entitlement.proof,
      });
      if (
        !instruction.data.equals(Buffer.from(job.expectations.dataBase64, 'base64')) ||
        instruction.keys.map((key) => key.pubkey.toBase58()).join(',') !==
          job.expectations.accounts.join(',')
      )
        throw new Error('Community renewal cannot change its exact proof or accounts');
      const old = VersionedTransaction.deserialize(Buffer.from(job.transaction_base64, 'base64')),
        next = VersionedTransaction.deserialize(Buffer.from(proof.transactionBase64, 'base64'));
      if (
        next.signatures.some((signature) => signature.some((byte) => byte !== 0)) ||
        messageDigest(next.message.serialize()) !== proof.messageDigest
      )
        throw new Error('Community renewal must require a fresh wallet signature');
      next.message.recentBlockhash = old.message.recentBlockhash;
      if (!Buffer.from(next.message.serialize()).equals(Buffer.from(old.message.serialize())))
        throw new Error('Community renewal may replace only the blockhash');
      await client.query(
        `INSERT INTO financial_claim_attempts(job_id,signature,message_digest,transaction_base64,last_valid_block_height,previous_status,
        finalized_expiry_height,finalized_proof_slot) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          job.id,
          job.signature,
          job.message_digest,
          job.transaction_base64,
          job.last_valid_block_height,
          job.status,
          proof.finalizedHeight,
          proof.finalizedSlot,
        ]
      );
      return (
        await client.query<FinancialJob>(
          `UPDATE financial_jobs SET transaction_base64=$2,message_digest=$3,last_valid_block_height=$4,
        signature=NULL,status='prepared',finalized_slot=NULL,updated_at=now() WHERE id=$1 RETURNING *`,
          [job.id, proof.transactionBase64, proof.messageDigest, proof.lastValidBlockHeight]
        )
      ).rows[0]!;
    });
  }

  async settleExecution(id: string, evidence: FinalizedEvidence): Promise<FinancialJob> {
    assertFinalizedEvidence(evidence);
    const candidate = await this.job(id);
    if (candidate?.kind === 'community_claim') {
      if (candidate.epoch === null || !candidate.recipient)
        throw new Error('Community claim identity is missing');
      const program = new PublicKey(this.vaultProgram),
        { coin } = vaultAddresses(program, new PublicKey(candidate.mint));
      const epoch = epochAddress(program, coin, BigInt(candidate.epoch));
      const marker = claimAddress(program, epoch, new PublicKey(candidate.recipient));
      const account = await readEvidenceAccount(evidence, marker),
        data = account?.data;
      if (
        !account?.owner.equals(program) ||
        !data ||
        data.length !== 82 ||
        data.subarray(0, 8).toString() !== 'RCLAIM01' ||
        data[8] !== 1 ||
        !data.subarray(10, 42).equals(epoch.toBuffer()) ||
        !data.subarray(42, 74).equals(new PublicKey(candidate.recipient).toBuffer()) ||
        data.readBigUInt64LE(74) !== BigInt(candidate.lamports)
      )
        throw new Error('Immutable finalized claim marker does not prove this owner payout');
    }
    return this.tx(async (client) => {
      const job = (
        await client.query<FinancialJob>('SELECT * FROM financial_jobs WHERE id=$1 FOR UPDATE', [
          id,
        ])
      ).rows[0];
      if (
        !job ||
        job.network_genesis !== evidence.networkGenesis ||
        job.signature !== evidence.signature ||
        job.message_digest !== evidence.messageDigest
      )
        throw new Error('Finalized receipt does not belong to this execution');
      if (job.status === 'finalized') return job;
      if (!['submitted', 'signed', 'manual_review'].includes(job.status))
        throw new Error('Unexpected execution state');
      const expected = job.expectations;
      requireInstruction(evidence, {
        program: this.vaultProgram,
        accounts: expected.accounts,
        data: Buffer.from(expected.dataBase64, 'base64'),
      });
      let received = 0n;
      const vaultChange =
        lamportDelta(evidence, expected.vault) -
        (expected.unwrapAccount
          ? closedNativeAccountRent(evidence, expected.unwrapAccount, expected.vault)
          : 0n);
      if (expected.effect === 'buyback') {
        received = tokenDelta(evidence, expected.tokenAccount!, job.mint);
        if (
          received <= 0n ||
          received < BigInt(expected.minTokens ?? '0') ||
          vaultChange !== -BigInt(job.lamports)
        )
          throw new Error('Unexpected executed buyback amounts');
      } else if (expected.effect === 'burn') {
        if (
          tokenDelta(evidence, expected.tokenAccount!, job.mint) !== -BigInt(job.tokens) ||
          actualBurnedTokens(evidence, expected.tokenAccount!, job.mint, expected.vault) !==
            BigInt(job.tokens)
        )
          throw new Error('Unexpected burn amount');
      } else if (expected.effect === 'buyback_burn') {
        if (!expected.poolTokenVault || !expected.tokenAccount)
          throw new Error('Canonical buyback token accounts are required');
        received = purchasedTokens(
          evidence,
          expected.poolTokenVault,
          expected.tokenAccount,
          job.mint
        );
        if (
          received <= 0n ||
          received < BigInt(expected.minTokens ?? '0') ||
          actualBurnedTokens(evidence, expected.tokenAccount, job.mint, expected.vault) !==
            received ||
          tokenDelta(evidence, expected.tokenAccount, job.mint) !== 0n ||
          vaultChange !== -BigInt(job.lamports)
        )
          throw new Error(
            'Atomic buyback must burn exactly the actually received purchased tokens'
          );
      } else if (
        vaultChange !== -BigInt(job.lamports) ||
        !job.recipient ||
        netClaimCredit(
          evidence,
          job.recipient,
          job.kind === 'community_claim' ? expected.accounts[3] : undefined
        ) !== BigInt(job.lamports)
      ) {
        throw new Error('Unexpected executed claim amount');
      }
      if (job.bucket)
        await client.query(
          `UPDATE financial_balances SET reserved=reserved-$4,spent=spent+$4
        WHERE network_genesis=$1 AND mint=$2 AND bucket=$3`,
          [job.network_genesis, job.mint, job.bucket, job.lamports]
        );
      return (
        await client.query<FinancialJob>(
          `UPDATE financial_jobs SET status='finalized',finalized_slot=$2,
        received_tokens=$3,updated_at=now() WHERE id=$1 RETURNING *`,
          [id, evidence.slot, received.toString()]
        )
      ).rows[0]!;
    });
  }

  async balances(network: string, mint: string) {
    return this.tx(async (client) => {
      await this.coin(client, network, mint);
      const rows = (
        await client.query<{
          bucket: Bucket;
          accrued: string;
          funded: string;
          reserved: string;
          spent: string;
        }>(
          'SELECT bucket,accrued,funded,reserved,spent FROM financial_balances WHERE network_genesis=$1 AND mint=$2',
          [network, mint]
        )
      ).rows;
      return rows.map((row) => ({
        ...row,
        available: (BigInt(row.funded) - BigInt(row.reserved) - BigInt(row.spent)).toString(),
      }));
    });
  }

  async unfundedEvents(
    network: string,
    mint: string,
    limit = 10_000
  ): Promise<{ id: EventId; pool: string; net: bigint }[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
      throw new Error('Invalid fee selection bound');
    return this.tx(async (client) =>
      (
        await client.query<{
          signature: string;
          instruction_index: number;
          event_index: number;
          pool: string;
          net: string;
        }>(
          `SELECT e.signature,e.instruction_index,e.event_index,e.pool,(e.total-e.protocol-e.referral) AS net FROM financial_fee_events e
       WHERE e.network_genesis=$1 AND e.mint=$2 AND e.total>e.protocol+e.referral AND
       NOT EXISTS(SELECT 1 FROM financial_planned_fee_events p WHERE p.network_genesis=e.network_genesis AND
           p.signature=e.signature AND p.instruction_index=e.instruction_index AND p.event_index=e.event_index) AND
       NOT EXISTS(SELECT 1 FROM financial_zero_fee_events z WHERE z.network_genesis=e.network_genesis AND
           z.signature=e.signature AND z.instruction_index=e.instruction_index AND z.event_index=e.event_index)
       ORDER BY e.finalized_slot,e.signature,e.instruction_index,e.event_index LIMIT $3`,
          [network, mint, limit]
        )
      ).rows.map((row) => ({
        id: {
          signature: row.signature,
          instructionIndex: row.instruction_index,
          eventIndex: row.event_index,
        },
        pool: row.pool,
        net: BigInt(row.net),
      }))
    );
  }

  async indexCursor(network: string, pool: string): Promise<FinancialIndexCursor> {
    return this.tx(async (client) => {
      await client.query(
        `INSERT INTO financial_index_cursors(network_genesis,pool) VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [network, pool]
      );
      return (
        await client.query<FinancialIndexCursor>(
          'SELECT * FROM financial_index_cursors WHERE network_genesis=$1 AND pool=$2',
          [network, pool]
        )
      ).rows[0]!;
    });
  }

  async advanceIndexCursor(input: FinancialIndexCursor): Promise<FinancialIndexCursor> {
    return this.tx(async (client) => {
      const result = await client.query<FinancialIndexCursor>(
        `UPDATE financial_index_cursors SET newest_signature=$3,oldest_signature=$4,
        complete=$5,scan_head_signature=$6,scan_before_signature=$7,scan_until_signature=$8,finalized_slot=$9,version=version+1,updated_at=now()
        WHERE network_genesis=$1 AND pool=$2 AND version=$10 RETURNING *`,
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
      );
      if (!result.rows[0])
        throw new Error('Another index worker advanced this pool; retry from its durable cursor');
      return result.rows[0];
    });
  }
}
