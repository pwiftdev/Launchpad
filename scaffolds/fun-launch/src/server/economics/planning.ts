import { Connection, PublicKey } from '@solana/web3.js';
import {
  deriveDbcPoolAuthority,
  deriveDammV2PoolAuthority,
  DynamicBondingCurveClient,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { database } from '../database';
import { migrationHistoryBoundary, discoverMigrationBoundary } from '../migrationRegistry';
import { FinancialStore, type EventId, type FundingSourceKind } from './financialStore';
import { FinalizedFeeIndexer } from './finalizedIndexer';
import { FinalizedVerifier } from './chainEvidence';
import { MeteoraFinancialAdapter, VaultAccountSetupRequired } from './meteoraAdapter';
import { prepareOperatorPlan, type OperatorPlan } from './operatorStore';
import { collectHolderSnapshot } from './holderSnapshot';
import { prepareVaultMigrationBinding } from '../graduationBinding';

export type HourlyPlanningDependencies = {
  clock: () => Promise<{ blockTime: number }>;
  existing: (epoch: number) => Promise<boolean>;
  capture: (epoch: number) => Promise<void>;
  prepare: (epoch: number) => Promise<void>;
};

/** One bounded attempt, suitable for a scheduler every 15s. A missed boundary is never backdated. */
export async function planHourlyRewards(deps: HourlyPlanningDependencies) {
  const clock = await deps.clock(),
    epoch = Math.floor(clock.blockTime / 3600) - 1;
  if (!Number.isSafeInteger(clock.blockTime) || epoch < 0)
    throw new Error('Invalid finalized planner clock');
  if (await deps.existing(epoch)) {
    await deps.prepare(epoch);
    return { epoch, status: 'existing' as const };
  }
  if (clock.blockTime % 3600 >= 60) return { epoch, status: 'outside_boundary' as const };
  await deps.capture(epoch);
  await deps.prepare(epoch);
  return { epoch, status: 'prepared' as const };
}

/** Finite unsigned planning only. This path has no signer, relay, secret-key loader or spend loop. */
export async function planFinancialCoin(input: {
  rpc: Connection;
  store: FinancialStore;
  networkGenesis: string;
  program: PublicKey;
  operator: PublicKey;
  mint: PublicKey;
}) {
  const { rpc, store, networkGenesis: genesis, program, operator, mint } = input;
  const adapter = new MeteoraFinancialAdapter(rpc, store, program, operator, genesis),
    state = await adapter.state(mint),
    coin = state.registered;
  const source = {
    networkGenesis: genesis,
    mint: mint.toBase58(),
    pool: coin.dbc_pool,
    configKey: coin.config_key,
    activationPoint: Number(coin.activation_point),
    mode: coin.mode,
    creatorShareBps: coin.creator_share_bps,
  };
  const indexer = new FinalizedFeeIndexer(rpc, store),
    dbc = await indexer.runPool(source, {
      creationSignature: coin.creation_signature,
      route: 'dbc',
    });
  if (dbc.paused || !dbc.complete)
    return { status: 'index_paused', dbc, transactionsSigned: false, transactionsSent: false };
  if (state.migratedPool.equals(PublicKey.default)) {
    const actual = await new DynamicBondingCurveClient(rpc, 'finalized').state.getPool(
      new PublicKey(coin.dbc_pool)
    );
    if (!actual) throw new Error('Canonical DBC state unavailable');
    if (Number(actual.poolState.isMigrated) === 1) {
      const binding = await prepareVaultMigrationBinding({
        rpc,
        networkGenesis: genesis,
        programId: program,
        mint,
        operator,
      });
      if (binding.status === 'already-bound')
        return {
          status: 'binding_changed_recheck',
          transactionsSigned: false,
          transactionsSent: false,
        };
      const plan = await prepareOperatorPlan({
        networkGenesis: genesis,
        mint: mint.toBase58(),
        kind: 'setup',
        intentKey: binding.intentKey,
        transactionBase64: binding.transactionBase64,
        lastValidBlockHeight: binding.lastValidBlockHeight,
        metadata: { effect: 'bind_migration', expected: binding.expected },
      });
      return {
        status: 'migration_binding_required',
        plan: { id: plan.id, status: plan.status, kind: plan.kind },
        dbc,
        transactionsSigned: false,
        transactionsSent: false,
      };
    }
  }
  let damm: Awaited<ReturnType<typeof indexer.runPool>> | null = null;
  if (!state.migratedPool.equals(PublicKey.default)) {
    let boundary = await migrationHistoryBoundary(genesis, mint.toBase58());
    if (!boundary) {
      await discoverMigrationBoundary(genesis, mint.toBase58());
      boundary = await migrationHistoryBoundary(genesis, mint.toBase58());
    }
    damm = await indexer.runPool(
      { ...source, pool: state.migratedPool.toBase58() },
      { creationSignature: boundary?.signature ?? null, route: 'damm-v2' }
    );
    if (damm.paused || !damm.complete)
      return {
        status: 'index_paused',
        dbc,
        damm,
        transactionsSigned: false,
        transactionsSent: false,
      };
  }
  const plans: OperatorPlan[] = [];
  let zeroNormalization: unknown = null;
  const pending = (
    await database().query<{ commitment: string; source_kind: FundingSourceKind }>(
      `SELECT commitment,source_kind FROM financial_funding_plans
    WHERE network_genesis=$1 AND mint=$2 AND status='prepared' ORDER BY created_at LIMIT 1`,
      [genesis, mint.toBase58()]
    )
  ).rows[0];
  let events: EventId[] = [],
    sourceKind: FundingSourceKind | undefined;
  if (pending) {
    sourceKind = pending.source_kind;
    const rows = (
      await database().query<{ signature: string; instruction_index: number; event_index: number }>(
        `SELECT signature,instruction_index,event_index
      FROM financial_planned_fee_events WHERE network_genesis=$1 AND mint=$2 AND commitment=$3`,
        [genesis, mint.toBase58(), pending.commitment]
      )
    ).rows;
    events = rows.map((row) => ({
      signature: row.signature,
      instructionIndex: row.instruction_index,
      eventIndex: row.event_index,
    }));
  } else {
    const available = await store.unfundedEvents(genesis, mint.toBase58(), 1000),
      pool = available[0]?.pool;
    const selected = available.filter((event) => event.pool === pool);
    if (state.unallocatedCollected > 0n && pool === state.migratedPool.toBase58()) {
      sourceKind = 'collected_allocation';
    }
    events = selected.map((event) => event.id);
  }
  let needsSetup = false;
  let prepared: Awaited<ReturnType<typeof adapter.prepareFunding>> | null = null;
  if (events.length) {
    try {
      prepared = await adapter.prepareFunding(mint, events, sourceKind);
    } catch (error) {
      if (!(error instanceof VaultAccountSetupRequired)) throw error;
      needsSetup = true;
    }
  }
  if (needsSetup) {
    const setup = await adapter.setupAccounts(mint);
    plans.push(
      await prepareOperatorPlan({
        networkGenesis: genesis,
        mint: mint.toBase58(),
        kind: 'setup',
        intentKey: `scheduled-setup:${mint}:${state.rinseNet}:${state.postNet}:${state.nonce}`,
        ...setup,
        metadata: {},
      })
    );
  } else if (prepared) {
    if ('normalizedZero' in prepared) zeroNormalization = prepared;
    else {
      plans.push(
        await prepareOperatorPlan({
          networkGenesis: genesis,
          mint: mint.toBase58(),
          kind: 'funding',
          intentKey: `funding:${prepared.plan.commitment}`,
          transactionBase64: prepared.transactionBase64,
          lastValidBlockHeight: prepared.lastValidBlockHeight,
          metadata: {
            events,
            sourceKind: prepared.plan.sourceKind,
            commitment: prepared.plan.commitment,
            vault: prepared.vault,
            unwrapAccount: 'unwrapAccount' in prepared ? prepared.unwrapAccount : undefined,
            sourceQuoteVault:
              'sourceQuoteVault' in prepared ? prepared.sourceQuoteVault : undefined,
            accounts: prepared.instruction.keys.map((key) => key.pubkey.toBase58()),
            dataBase64: prepared.instruction.data.toString('base64'),
            instructionIndex: 0,
          },
        })
      );
    }
  }
  let hourly: Awaited<ReturnType<typeof planHourlyRewards>> | null = null;
  if (coin.mode === 'community') {
    const balance = (await store.balances(genesis, mint.toBase58())).find(
      (row) => row.bucket === 'community'
    );
    if (BigInt(balance?.available ?? '0') > 0n) {
      hourly = await planHourlyRewards({
        clock: () => new FinalizedVerifier(rpc, genesis).clock(),
        existing: async (epoch) =>
          (await store.rewardEpoch(genesis, mint.toBase58(), epoch)) !== null,
        capture: async (epoch) => {
          const snapshot = await collectHolderSnapshot(rpc, {
            networkGenesis: genesis,
            mint: mint.toBase58(),
            maximumAccounts: 100_000,
            excludedOwners: new Set([
              state.addresses.coin.toBase58(),
              state.addresses.feeAuthority.toBase58(),
              deriveDbcPoolAuthority().toBase58(),
              deriveDammV2PoolAuthority().toBase58(),
              PublicKey.default.toBase58(),
            ]),
          });
          await store.createRewardEpoch({
            networkGenesis: genesis,
            mint: mint.toBase58(),
            epoch,
            snapshot,
          });
        },
        prepare: async (epoch) => {
          const saved = await store.rewardEpoch(genesis, mint.toBase58(), epoch);
          if (!saved || saved.status !== 'prepared' || BigInt(saved.allocated) <= 0n) return;
          const prepared = await adapter.prepareEpoch(mint, epoch);
          plans.push(
            await prepareOperatorPlan({
              networkGenesis: genesis,
              mint: mint.toBase58(),
              kind: 'epoch',
              intentKey: `epoch:${mint}:${epoch}`,
              transactionBase64: prepared.transactionBase64,
              lastValidBlockHeight: prepared.lastValidBlockHeight,
              metadata: {
                epoch,
                accounts: prepared.instruction.keys.map((key) => key.pubkey.toBase58()),
                dataBase64: prepared.instruction.data.toString('base64'),
              },
            })
          );
        },
      });
    }
  }
  return {
    status: needsSetup ? 'setup_required' : 'planned',
    zeroNormalization,
    dbc,
    damm,
    hourly,
    plans: plans.map((plan) => ({
      id: plan.id,
      kind: plan.kind,
      status: plan.status,
      messageDigest: plan.message_digest,
      lastValidBlockHeight: plan.last_valid_block_height,
    })),
    transactionsSigned: false,
    transactionsSent: false,
    nextStep:
      'External operator reviews/signs exact unsigned plans, relays and reconciles finalized receipts. No automatic spending.',
  };
}
