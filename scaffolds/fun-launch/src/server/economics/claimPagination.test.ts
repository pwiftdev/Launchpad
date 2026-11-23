import { afterAll, beforeAll, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Pool, PoolClient } from 'pg';
import { Keypair } from '@solana/web3.js';
import { FinancialStore } from './financialStore';

const db = new PGlite(),
  wallet = Keypair.generate().publicKey.toBase58();
const adapter = {
  connect: async () =>
    ({
      query: (sql: string, values?: unknown[]) => db.query(sql, values),
      release() {},
    }) as unknown as PoolClient,
} as Pick<Pool, 'connect'>;
const store = new FinancialStore(adapter, Keypair.generate().publicKey.toBase58());
beforeAll(async () => {
  await db.exec(`CREATE TABLE financial_entitlements(network_genesis text,mint text,epoch bigint,wallet text,lamports numeric,proof jsonb);
 CREATE TABLE financial_epochs(network_genesis text,mint text,epoch bigint,status text,merkle_root text,snapshot_slot bigint);
 CREATE TABLE financial_jobs(network_genesis text,mint text,epoch bigint,recipient text,kind text,status text,id text,signature text);`);
  await db.query(
    `INSERT INTO financial_entitlements SELECT 'test','mint',n,$1,100,'[]'::jsonb FROM generate_series(1,125) n`,
    [wallet]
  );
  await db.exec(
    `INSERT INTO financial_epochs SELECT 'test','mint',n,'funded','root',n FROM generate_series(1,125) n;`
  );
});
afterAll(() => db.close());
it('keeps old funded entitlements accessible after more than 100 hourly allocations', async () => {
  const first = await store.claimable('test', 'mint', wallet, { limit: 10 });
  expect(first.map((row) => row.epoch)).toEqual(
    Array.from({ length: 10 }, (_, i) => String(125 - i))
  );
  const older = await store.claimable('test', 'mint', wallet, { limit: 10, beforeEpoch: 116 });
  expect(older[0]?.epoch).toBe('115');
  const oldClaim = await store.claimable('test', 'mint', wallet, { epoch: 1, limit: 1 });
  expect(oldClaim).toHaveLength(1);
  expect(oldClaim[0]?.epoch).toBe('1');
  await expect(store.claimable('test', 'mint', wallet, { limit: 101 })).rejects.toThrow(
    'page size'
  );
});
