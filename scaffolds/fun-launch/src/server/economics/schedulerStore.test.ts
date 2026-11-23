import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { fixtureGenesis, fixtureWallet } from './financialFixtures';
import { FinancialSchedulerStore } from './schedulerStore';

let db: PGlite, store: FinancialSchedulerStore;
const config = fixtureWallet().publicKey.toBase58(),
  owner = fixtureWallet().publicKey.toBase58(),
  program = fixtureWallet().publicKey.toBase58(),
  mints = Array.from({ length: 4 }, () => fixtureWallet().publicKey.toBase58()).sort();
beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  for (const file of [
    '003-launch-registry.sql',
    '004-financial.sql',
    '016-financial-scheduler.sql',
  ])
    await db.exec(
      readFileSync(new URL(`../../../../../scripts/migrations/${file}`, import.meta.url), 'utf8')
    );
  await db.query(
    `INSERT INTO launch_configs(network_genesis,config_key,policy_version,expected_fee_claimer,expected_leftover_receiver,config_digest,verified_slot,enabled_for_launch)
    VALUES($1,$2,'rinse-v1',$3,$3,$4,1,false)`,
    [fixtureGenesis, config, owner, 'a'.repeat(64)]
  );
  for (const [index, mint] of mints.entries())
    await db.query(
      `INSERT INTO launch_coins(network_genesis,mint,dbc_pool,config_key,original_deployer,mode,recipient,policy_version,activation_point,creation_signature,finalized_slot)
    VALUES($1,$2,$3,$4,$5,'creator',$5,$6,1,$7,1)`,
      [
        fixtureGenesis,
        mint,
        fixtureWallet().publicKey.toBase58(),
        config,
        owner,
        index === 3 ? 'legacy-devnet' : 'rinse-v1',
        `creation${index}`,
      ]
    );
  const pool = {
    query: async (sql: string, args?: unknown[]) => ({ rows: (await db.query(sql, args)).rows }),
  } as unknown as Pick<Pool, 'query' | 'connect'>;
  store = new FinancialSchedulerStore(fixtureGenesis, program, pool);
}, 20000);
afterAll(async () => {
  await db?.close();
});
describe('scheduler durable discovery and receipt selection', () => {
  it('continues reviewed existing coins when new launches are disabled and wraps a bounded fair cursor', async () => {
    expect(await store.discover(2)).toEqual(mints.slice(0, 2));
    await db.query(
      `INSERT INTO financial_scheduler_state(network_genesis,program_id,cursor_mint,last_status)VALUES($1,$2,$3,'running')`,
      [fixtureGenesis, program, mints[1]]
    );
    // A fresh store/process reads persisted cursor, including a crash's running heartbeat.
    expect(await store.discover(2)).toEqual([mints[2], mints[0]]);
    await db.exec(
      readFileSync(
        new URL('../../../../../scripts/migrations/016-financial-scheduler.sql', import.meta.url),
        'utf8'
      )
    );
    expect(await store.discover(2)).toEqual([mints[2], mints[0]]);
    expect(
      (await db.query<{ last_status: string }>('SELECT last_status FROM financial_scheduler_state'))
        .rows[0]?.last_status
    ).toBe('running');
  });
  it('selects only stored unresolved signatures, caps the backlog and never invents a signature', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, id] of ids.entries())
      await db.query(
        `INSERT INTO financial_operator_plans(id,network_genesis,mint,kind,intent_key,transaction_base64,message_digest,last_valid_block_height,metadata,status,signature)
      VALUES($1::uuid,$2,$3,'setup',$1::text,'unsigned',$4,1,'{}',$5,$6)`,
        [
          id,
          fixtureGenesis,
          mints[0],
          'b'.repeat(64),
          index === 0 ? 'prepared' : index === 1 ? 'submitted' : 'manual_review',
          index === 0 ? null : `signature${index}`,
        ]
      );
    const first = await store.pending(mints[0]!, 1);
    expect(first.receipts).toHaveLength(1);
    expect(first.more).toBe(true);
    expect(first.receipts[0]!.id).not.toBe(ids[0]);
    const all = await store.pending(mints[0]!, 3);
    expect(all.more).toBe(false);
    expect(new Set(all.receipts.map((row) => row.id))).toEqual(new Set(ids.slice(1)));
    await db.query("UPDATE financial_operator_plans SET status='finalized' WHERE id=$1", [ids[1]]);
    expect((await store.pending(mints[0]!, 3)).receipts).toEqual([
      { id: ids[2], kind: 'operator' },
    ]);
  });
});
