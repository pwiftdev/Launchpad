import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Pool, PoolClient } from 'pg';
import type { Connection } from '@solana/web3.js';
import { fixtureGenesis, fixtureWallet } from './financialFixtures';
import { FinancialStore, type EventId } from './financialStore';
import { verifyDammRealization } from './dammRealization';

vi.mock('./dammRealization', () => {
  const verified = new WeakSet<object>();
  return {
    assertDammRealization: (proof: object) => {
      if (!verified.has(proof)) throw new Error('Independent proof required');
    },
    verifyDammRealization: async (args: {
      genesis: string;
      mint: string;
      pool: string;
      eventIds: EventId[];
      rawExpected: bigint;
      source: string;
    }) => {
      const cash = args.eventIds.some((event) => event.signature === 'later-positive') ? 1n : 0n;
      const proof = {
        networkGenesis: args.genesis,
        mint: args.mint,
        pool: args.pool,
        slot: 1000,
        source: args.source,
        rawExpected: args.rawExpected,
        realizedNet: cash,
        shortfall: args.rawExpected - cash,
        externalLpExcluded: 0n,
        roundingLoss: args.rawExpected - cash,
        zeroCash: cash === 0n,
        eventIds: args.eventIds,
        windows: [] as unknown[],
        accountedRealizedNet: '0',
        accountedExternalLpExcluded: '0',
        accountedRoundingLoss: '0',
        digest: 'a'.repeat(64),
      };
      verified.add(proof);
      return proof;
    },
  };
});
let db: PGlite, store: FinancialStore;
const mint = fixtureWallet().publicKey,
  config = fixtureWallet().publicKey,
  pool = fixtureWallet().publicKey,
  program = fixtureWallet().publicKey,
  wallet = fixtureWallet().publicKey;
beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  let queue = Promise.resolve();
  const adapter = {
    connect: async () => {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      return {
        query: async (sql: string, parameters?: unknown[]) => {
          const row = await db.query(sql, parameters);
          return { rows: row.rows, rowCount: row.affectedRows ?? row.rows.length };
        },
        release,
      } as unknown as PoolClient;
    },
  } as Pick<Pool, 'connect'>;
  store = new FinancialStore(adapter, program.toBase58(), async () => true);
}, 20000);
beforeEach(async () => {
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const migration of [
    '003-launch-registry.sql',
    '004-financial.sql',
    '008-financial-realization.sql',
    '009-finalized-fee-windows.sql',
    '011-zero-owned-fees.sql',
  ])
    await db.exec(
      readFileSync(
        new URL(`../../../../../scripts/migrations/${migration}`, import.meta.url),
        'utf8'
      )
    );
  await db.query(
    `INSERT INTO launch_configs(network_genesis,config_key,policy_version,expected_fee_claimer,expected_leftover_receiver,config_digest,verified_slot)
    VALUES($1,$2,'rinse-v1',$3,$3,$4,1)`,
    [fixtureGenesis, config.toBase58(), wallet.toBase58(), 'b'.repeat(64)]
  );
  await db.query(
    `INSERT INTO launch_coins(network_genesis,mint,dbc_pool,config_key,original_deployer,mode,recipient,policy_version,activation_point,creation_signature,finalized_slot)
    VALUES($1,$2,$3,$4,$5,'creator',$5,'rinse-v1',1,'creation',1)`,
    [
      fixtureGenesis,
      mint.toBase58(),
      fixtureWallet().publicKey.toBase58(),
      config.toBase58(),
      wallet.toBase58(),
    ]
  );
});
afterAll(async () => {
  await db?.close();
});
async function seed(signature: string) {
  await db.query(
    `INSERT INTO financial_fee_events(network_genesis,mint,pool,signature,instruction_index,event_index,finalized_slot,trade_time,phase,
    total,protocol,referral,rinse_buyback,creator,community,platform,event_digest) VALUES($1,$2,$3,$4,0,1,1,100,1,1,0,0,0,0,0,1,$5)`,
    [fixtureGenesis, mint.toBase58(), pool.toBase58(), signature, 'c'.repeat(64)]
  );
  return { signature, instructionIndex: 0, eventIndex: 1 };
}
async function proof(events: EventId[], source: 'position' | 'audit' = 'position') {
  return verifyDammRealization({
    rpc: {} as Connection,
    genesis: fixtureGenesis,
    mint: mint.toBase58(),
    pool: pool.toBase58(),
    rawExpected: BigInt(events.length),
    eventCount: events.length,
    eventIds: events,
    source,
  });
}
describe('zero-owned prefix normalization', () => {
  it('consumes an all-zero raw set without a funding receipt, reservation or fabricated lamport', async () => {
    const events = [await seed('zero-one'), await seed('zero-two')],
      verified = await proof(events);
    await expect(
      store.normalizeZeroFees(fixtureGenesis, mint.toBase58(), events, 'damm_claim', {
        ...verified,
      })
    ).rejects.toThrow('Independent');
    expect(
      await store.normalizeZeroFees(fixtureGenesis, mint.toBase58(), events, 'damm_claim', verified)
    ).toMatchObject({ normalizedZero: true, eventsNormalized: 2, rawObserved: 2n });
    expect(
      await store.normalizeZeroFees(fixtureGenesis, mint.toBase58(), events, 'damm_claim', verified)
    ).toMatchObject({ eventsNormalized: 0 });
    expect(await store.unfundedEvents(fixtureGenesis, mint.toBase58())).toEqual([]);
    for (const table of [
      'financial_funding',
      'financial_funding_plans',
      'financial_balances',
      'financial_planned_fee_events',
    ])
      expect((await db.query('SELECT * FROM ' + table)).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM financial_fee_events')).rows).toHaveLength(2);
    await expect(db.query('DELETE FROM financial_zero_fee_events')).rejects.toThrow('append-only');
  });
  it('keeps later positive prefix cash fundable without reopening an earlier zero raw event', async () => {
    const zero = await seed('zero-one'),
      later = await seed('later-positive');
    await store.normalizeZeroFees(
      fixtureGenesis,
      mint.toBase58(),
      [zero],
      'damm_claim',
      await proof([zero])
    );
    expect(
      (await store.unfundedEvents(fixtureGenesis, mint.toBase58())).map((event) => event.id)
    ).toEqual([later]);
    const positive = await store.reserveRealizedFunding(
      fixtureGenesis,
      mint.toBase58(),
      [later],
      'damm_claim',
      await proof([later])
    );
    expect(positive.lamports).toBe(1n);
    expect(positive.events.map((event) => event.id)).toEqual([later]);
    expect((await db.query('SELECT * FROM financial_funding')).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM financial_zero_fee_events')).rows).toHaveLength(1);
    await expect(
      store.previewFundingPlan(fixtureGenesis, mint.toBase58(), [zero], 'damm_claim')
    ).rejects.toThrow('unknown or already funded');
    await expect(
      store.normalizeZeroFees(
        fixtureGenesis,
        mint.toBase58(),
        [zero],
        'damm_claim',
        await proof([zero], 'audit')
      )
    ).rejects.toThrow('zero-owned-cash');
  });
});
