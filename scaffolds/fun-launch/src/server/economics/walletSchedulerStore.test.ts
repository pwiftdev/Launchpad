import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { WalletSchedulerStore } from './walletSchedulerStore';
import { fixtureGenesis, fixtureWallet } from './financialFixtures';
let db: PGlite,
  store: WalletSchedulerStore,
  held = false,
  lastClient: EventEmitter;
const collector = fixtureWallet().publicKey.toBase58(),
  config = fixtureWallet().publicKey.toBase58(),
  mints = Array.from({ length: 3 }, () => fixtureWallet().publicKey.toBase58()).sort();
beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  for (const name of ['003-launch-registry.sql', '017-wallet-settlement.sql'])
    await db.exec(
      readFileSync(new URL(`../../../../../scripts/migrations/${name}`, import.meta.url), 'utf8')
    );
  await db.query(
    `INSERT INTO launch_configs(network_genesis,config_key,policy_version,expected_fee_claimer,expected_leftover_receiver,config_digest,verified_slot,enabled_for_launch)VALUES($1,$2,'wallet-v1',$3,$3,$4,1,false)`,
    [fixtureGenesis, config, collector, 'a'.repeat(64)]
  );
  for (const mint of mints)
    await db.query(
      `INSERT INTO launch_coins(network_genesis,mint,dbc_pool,config_key,original_deployer,mode,recipient,policy_version,activation_point,creation_signature,finalized_slot)VALUES($1,$2,$3,$4,$5,'creator',$5,'wallet-v1',1,$6,1)`,
      [
        fixtureGenesis,
        mint,
        fixtureWallet().publicKey.toBase58(),
        config,
        collector,
        `creation-${mint}`,
      ]
    );
  const query = async (sql: string, args?: unknown[]) => {
    if (sql.includes('pg_try_advisory_lock')) {
      const locked = !held;
      held = true;
      return { rows: [{ locked }] };
    }
    if (sql.includes('pg_advisory_unlock')) {
      held = false;
      return { rows: [] };
    }
    return { rows: (await db.query(sql, args)).rows };
  };
  const pool = {
    query,
    connect: async () => {
      const client = new EventEmitter();
      lastClient = client;
      return Object.assign(client, {
        query,
        release: (destroy?: boolean) => {
          if (destroy) held = false;
        },
      });
    },
  } as unknown as Pick<Pool, 'connect' | 'query'>;
  store = new WalletSchedulerStore(fixtureGenesis, collector, pool);
}, 20000);
afterAll(async () => db.close());
describe('wallet collector scheduler durable lease', () => {
  it('does not overlap workers, releases lease on exits, and resumes fair cursor after a process restart', async () => {
    const lease = await store.acquire();
    expect(lease).not.toBeNull();
    expect(await store.acquire()).toBeNull();
    expect(await store.discover(2)).toEqual(mints.slice(0, 2));
    await lease!.progress(mints[1]!, 2, 1);
    await lease!.release();
    const second = await store.acquire();
    expect(second).not.toBeNull();
    expect(await store.discover(2)).toEqual([mints[2], mints[0]]);
    await second!.finish('completed', 2, 0);
    await second!.release();
    const heartbeat = (
      await db.query('SELECT collector,cursor_mint,last_status FROM wallet_scheduler_state')
    ).rows[0];
    expect(heartbeat).toMatchObject({ collector, cursor_mint: mints[1], last_status: 'completed' });
  });
  it('connection death aborts the operation and rejects progress rather than claiming liveness', async () => {
    const lease = await store.acquire();
    lastClient.emit('error', new Error('lost'));
    expect(lease!.alive()).toBe(false);
    expect(lease!.signal!.aborted).toBe(true);
    await expect(lease!.progress(mints[0]!, 1, 0)).rejects.toThrow('lost');
    await lease!.release();
    const next = await store.acquire();
    expect(next).not.toBeNull();
    await next!.release();
  });
});
