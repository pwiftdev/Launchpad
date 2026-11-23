import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { collectFeesInstruction, vaultAddresses } from '@/lib/vault/client';
import {
  fixtureGenesis,
  fixtureWallet,
  transactionFixture,
  unsignedTransaction,
} from './financialFixtures';
import { FinancialStore, type FundingPlan } from './financialStore';
import {
  prepareOperatorPlan,
  attachOperatorSignature,
  markOperatorSubmitted,
  recoverCollectedFunding,
} from './operatorStore';
import { verifyCollectedFundingRecovery } from './fundingRecovery';
import { verifyDammRealization } from './dammRealization';
import type { Connection } from '@solana/web3.js';

const shared = vi.hoisted(() => ({ pool: null as unknown, state: null as unknown }));
vi.mock('../database', () => ({ database: () => shared.pool }));
vi.mock('./meteoraAdapter', () => ({
  MeteoraFinancialAdapter: class {
    async state() {
      return shared.state;
    }
  },
}));
vi.mock('./dammRealization', () => {
  const proofs = new WeakSet<object>();
  return {
    assertDammRealization: (proof: object) => {
      if (!proofs.has(proof)) throw new Error('Unverified realization');
    },
    verifyDammRealization: async (args: {
      genesis: string;
      mint: string;
      pool: string;
      rawExpected: bigint;
      eventIds: unknown[];
      source: string;
    }) => {
      const proof = {
        networkGenesis: args.genesis,
        mint: args.mint,
        pool: args.pool,
        slot: 1000,
        source: args.source,
        rawExpected: args.rawExpected,
        realizedNet: args.rawExpected - 1n,
        shortfall: 1n,
        externalLpExcluded: 0n,
        roundingLoss: 1n,
        windows: [] as unknown[],
        digest: 'b'.repeat(64),
        eventIds: args.eventIds,
        accountedRealizedNet: '0',
        accountedExternalLpExcluded: '0',
        accountedRoundingLoss: '0',
      };
      proofs.add(proof);
      return proof;
    },
  };
});
let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  for (const name of [
    '003-launch-registry.sql',
    '004-financial.sql',
    '006-financial-recovery.sql',
    '007-collected-funding-recovery.sql',
    '008-financial-realization.sql',
    '009-finalized-fee-windows.sql',
    '011-zero-owned-fees.sql',
  ])
    await db.exec(
      readFileSync(new URL(`../../../../../scripts/migrations/${name}`, import.meta.url), 'utf8')
    );
  let queue = Promise.resolve();
  const query = async (sql: string, parameters?: unknown[]) => {
    const row = await db.query(sql, parameters);
    return { rows: row.rows, rowCount: row.affectedRows ?? row.rows.length };
  };
  shared.pool = {
    query,
    connect: async () => {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      return { query, release };
    },
  };
}, 20000);
afterAll(async () => {
  await db?.close();
});

describe('atomic amount-changing funding recovery', () => {
  it.each([false, true])(
    'archives expired signed intents without changing raw cash facts (already-realized=%s)',
    async (modern) => {
      await db.exec('TRUNCATE TABLE launch_configs CASCADE');
      const operator = fixtureWallet(),
        mint = fixtureWallet().publicKey,
        program = fixtureWallet().publicKey,
        config = fixtureWallet().publicKey,
        pool = fixtureWallet().publicKey;
      const addresses = vaultAddresses(program, mint);
      let oldCommitment = 'a'.repeat(64);
      await db.query(
        `INSERT INTO launch_configs(network_genesis,config_key,policy_version,expected_fee_claimer,expected_leftover_receiver,config_digest,verified_slot)
      VALUES($1,$2,'rinse-v1',$3,$3,$4,1)`,
        [fixtureGenesis, config.toBase58(), operator.publicKey.toBase58(), 'c'.repeat(64)]
      );
      await db.query(
        `INSERT INTO launch_coins(network_genesis,mint,dbc_pool,config_key,original_deployer,mode,recipient,policy_version,activation_point,creation_signature,finalized_slot)
      VALUES($1,$2,$3,$4,$5,'creator',$5,'rinse-v1',1,'creation',1)`,
        [
          fixtureGenesis,
          mint.toBase58(),
          fixtureWallet().publicKey.toBase58(),
          config.toBase58(),
          operator.publicKey.toBase58(),
        ]
      );
      await db.query(
        `INSERT INTO financial_fee_events(network_genesis,mint,pool,signature,instruction_index,event_index,finalized_slot,trade_time,phase,total,protocol,referral,
      rinse_buyback,creator,community,platform,event_digest) VALUES($1,$2,$3,'raw-event',0,1,1,100,1,2000000,0,0,0,1000000,0,1000000,$4)`,
        [fixtureGenesis, mint.toBase58(), pool.toBase58(), 'd'.repeat(64)]
      );
      const adapter = shared.pool as Pick<Pool, 'connect'>;
      const realStore = new FinancialStore(adapter, program.toBase58(), async () => true);
      oldCommitment = (
        await realStore.previewFundingPlan(
          fixtureGenesis,
          mint.toBase58(),
          [{ signature: 'raw-event', instructionIndex: 0, eventIndex: 1 }],
          'damm_claim'
        )
      ).commitment;
      await db.query(
        `INSERT INTO financial_funding_plans(network_genesis,mint,commitment,source_kind) VALUES($1,$2,$3,'damm_claim')`,
        [fixtureGenesis, mint.toBase58(), oldCommitment]
      );
      await db.query(
        `INSERT INTO financial_planned_fee_events(network_genesis,mint,signature,instruction_index,event_index,commitment)
      VALUES($1,$2,'raw-event',0,1,$3)`,
        [fixtureGenesis, mint.toBase58(), oldCommitment]
      );
      await db.query(
        `INSERT INTO financial_collected_reserves(network_genesis,mint,lamports) VALUES($1,$2,1999999)`,
        [fixtureGenesis, mint.toBase58()]
      );
      let funding: FundingPlan = {
        commitment: oldCommitment,
        fundingId: oldCommitment,
        lamports: 2000000n,
        pool: pool.toBase58(),
        migrated: true,
        sourceKind: 'damm_claim',
        events: [
          {
            id: { signature: 'raw-event', instructionIndex: 0, eventIndex: 1 },
            phase: 1,
            net: 2000000n,
          },
        ],
        phases: [{ phase: 1, net: 2000000n }],
        allocation: { rinse_buyback: 0n, creator: 1000000n, community: 0n, platform: 1000000n },
      };
      if (modern) {
        await db.query('DELETE FROM financial_planned_fee_events');
        await db.query('DELETE FROM financial_funding_plans');
        const initialProof = await verifyDammRealization({
          rpc: {} as Connection,
          genesis: fixtureGenesis,
          mint: mint.toBase58(),
          pool: pool.toBase58(),
          rawExpected: 2000000n,
          eventCount: 1,
          eventIds: funding.events.map((event) => event.id),
          source: 'position',
        });
        funding = await realStore.reserveRealizedFunding(
          fixtureGenesis,
          mint.toBase58(),
          funding.events.map((event) => event.id),
          'damm_claim',
          initialProof
        );
        oldCommitment = funding.commitment;
      }
      const ix = collectFeesInstruction({
        programId: program,
        mint,
        operator: operator.publicKey,
        dexProgram: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
        claimAccounts: Array.from({ length: 15 }, () => ({
          pubkey: fixtureWallet().publicKey,
          isSigner: false,
          isWritable: true,
        })),
        fundingId: oldCommitment,
        commitment: oldCommitment,
        events: funding.phases,
        migrated: true,
      });
      const fixture = transactionFixture([ix], operator);
      const plan = await prepareOperatorPlan({
        networkGenesis: fixtureGenesis,
        mint: mint.toBase58(),
        kind: 'funding',
        intentKey: 'funding:' + oldCommitment,
        transactionBase64: unsignedTransaction(fixture.tx),
        lastValidBlockHeight: 900,
        metadata: {
          sourceKind: 'damm_claim',
          commitment: oldCommitment,
          events: funding.events.map((row) => row.id),
        },
      });
      await attachOperatorSignature(plan.id, fixture.tx.serialize().toString('base64'));
      const signed = await markOperatorSubmitted(plan.id);
      fixture.rpc.getBlockHeight = async () => 1001;
      fixture.rpc.isBlockhashValid = async () => ({ context: { slot: 1000 }, value: false });
      fixture.rpc.getAccountInfoAndContext = async () => ({ context: { slot: 1000 }, value: null });
      fixture.rpc.getLatestBlockhash = async () => ({
        blockhash: fixtureWallet().publicKey.toBase58(),
        lastValidBlockHeight: 1100,
      });
      shared.state = { slot: 1000, addresses, unallocatedCollected: 1999999n };
      const fake = {
        previewFundingPlan: async () => funding,
        dammAccountedTotals: async () => ({
          accountedRealizedNet: 0n,
          accountedExternalLpExcluded: 0n,
          accountedRoundingLoss: 0n,
        }),
      } as unknown as FinancialStore;
      const proof = await verifyCollectedFundingRecovery({
        rpc: fixture.rpc,
        store: fake,
        plan: signed,
        program,
        operator: operator.publicKey,
      });
      const attempts = await Promise.allSettled([
        recoverCollectedFunding(proof),
        recoverCollectedFunding(proof),
      ]);
      expect(attempts.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.filter((row) => row.status === 'rejected')).toHaveLength(1);
      expect((await db.query('SELECT * FROM financial_funding_recoveries')).rows).toHaveLength(1);
      expect(
        (
          await db.query<{ total: string }>(
            "SELECT total FROM financial_fee_events WHERE signature='raw-event'"
          )
        ).rows[0]!.total
      ).toBe('2000000');
      expect((await db.query('SELECT * FROM financial_funding')).rows).toHaveLength(0);
      expect((await db.query('SELECT * FROM financial_balances')).rows).toHaveLength(0);
      expect(
        (
          await db.query<{ commitment: string }>(
            'SELECT commitment FROM financial_planned_fee_events'
          )
        ).rows[0]!.commitment
      ).toBe(proof.commitment);
      expect(
        (
          await db.query<{ status: string }>(
            'SELECT status FROM financial_funding_plans WHERE commitment=$1',
            [oldCommitment]
          )
        ).rows[0]!.status
      ).toBe(modern ? 'prepared' : 'failed');
      expect(proof.reuseCommitment).toBe(modern);
      if (modern) expect(proof.commitment).toBe(oldCommitment);
      else expect(proof.commitment).not.toBe(oldCommitment);
      await expect(db.query('DELETE FROM financial_funding_recoveries')).rejects.toThrow(
        'append-only'
      );
      const updated = await realStore.previewFundingPlan(
        fixtureGenesis,
        mint.toBase58(),
        funding.events.map((row) => row.id),
        'collected_allocation'
      );
      expect(updated.lamports).toBe(1999999n);
      expect(updated.events[0]!.net).toBe(2000000n);
      expect(updated.realization?.roundingLoss).toBe(1n);
      expect(updated.phases).toEqual([{ phase: 1, net: 1999999n }]);
    }
  );
});
