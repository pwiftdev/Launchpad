import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { fixtureGenesis, fixtureWallet } from './financialFixtures';
import { recordFinalizedDammWindows } from './realizationFacts';
import type { VerifiedDammRealization } from './dammRealization';
const shared = vi.hoisted(() => ({ proofs: new WeakSet<object>() }));
vi.mock('./dammRealization', () => ({
  assertDammRealization: (proof: object) => {
    if (!shared.proofs.has(proof)) throw new Error('Unverified window proof');
  },
}));
let db: PGlite, client: PoolClient;
const mint = fixtureWallet().publicKey,
  pool = fixtureWallet().publicKey;
beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  for (const name of [
    '003-launch-registry.sql',
    '004-financial.sql',
    '009-finalized-fee-windows.sql',
    '012-fee-classification-policy.sql',
  ])
    await db.exec(
      readFileSync(new URL(`../../../../../scripts/migrations/${name}`, import.meta.url), 'utf8')
    );
  const wallet = fixtureWallet().publicKey,
    config = fixtureWallet().publicKey;
  await db.query(
    `INSERT INTO launch_configs(network_genesis,config_key,policy_version,expected_fee_claimer,expected_leftover_receiver,config_digest,verified_slot)
    VALUES($1,$2,'rinse-v1',$3,$3,$4,1)`,
    [fixtureGenesis, config.toBase58(), wallet.toBase58(), 'a'.repeat(64)]
  );
  await db.query(
    `INSERT INTO launch_coins(network_genesis,mint,dbc_pool,config_key,original_deployer,mode,recipient,policy_version,activation_point,creation_signature,finalized_slot)
    VALUES($1,$2,$3,$4,$5,'creator',$5,'rinse-v1',1,'creation',1)`,
    [fixtureGenesis, mint.toBase58(), pool.toBase58(), config.toBase58(), wallet.toBase58()]
  );
  client = {
    query: async (sql: string, parameters?: unknown[]) => {
      const row = await db.query(sql, parameters);
      return { rows: row.rows, rowCount: row.affectedRows ?? row.rows.length };
    },
  } as unknown as PoolClient;
}, 20000);
afterAll(async () => {
  await db?.close();
});
function proof(
  policy: string,
  external: string,
  rounding: string,
  actual = '49',
  metadata?: string
) {
  const value = {
    networkGenesis: fixtureGenesis,
    mint: mint.toBase58(),
    pool: pool.toBase58(),
    slot: 1000,
    digest: 'b'.repeat(64),
    historyDigest: 'c'.repeat(64),
    classificationPolicy: policy,
    windows: [
      {
        signature: 'actual-finalized-claim',
        raw: '100',
        realized: actual,
        external,
        rounding,
        bound: '2',
        events: 2,
        eventIdentityDigest: 'd'.repeat(64),
        metadata,
      },
    ],
  };
  shared.proofs.add(value);
  return value as unknown as VerifiedDammRealization;
}
describe('definitive versioned claim window facts', () => {
  it('preserves old categories, counts canonical Q128 once, and rejects any changed cash/category facts', async () => {
    const rational = proof('rational-ownership-v1', '50', '1'),
      canonical = proof('q128-growth-v1', '49', '2');
    await recordFinalizedDammWindows(client, rational);
    await recordFinalizedDammWindows(client, canonical);
    await recordFinalizedDammWindows(
      client,
      proof('q128-growth-v1', '49', '2', '49', 'new descriptive metadata')
    );
    expect((await db.query('SELECT * FROM financial_damm_claim_windows')).rows).toHaveLength(2);
    expect(
      (
        await db.query<{ cash: string }>(
          "SELECT sum(realized_owned)::text AS cash FROM financial_damm_claim_windows WHERE classification_policy='q128-growth-v1'"
        )
      ).rows[0]!.cash
    ).toBe('49');
    await expect(
      recordFinalizedDammWindows(client, proof('q128-growth-v1', '49', '1', '50'))
    ).rejects.toThrow('conflicts');
    await expect(recordFinalizedDammWindows(client, { ...canonical })).rejects.toThrow(
      'Unverified'
    );
    await expect(
      db.query('UPDATE financial_damm_claim_windows SET realized_owned=50')
    ).rejects.toThrow('append-only');
  });
});
