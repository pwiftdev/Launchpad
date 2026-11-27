import { readdirSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixtureGenesis, fixtureWallet } from './financialFixtures';
import { WalletStore } from './walletStore';
import { mskdBuybackMint } from './maskedBuyback';
import { OFFICIAL_MSKD } from '@/constants/officialMskd';
import { NETWORK_GENESIS } from '../../../../../scripts/network-policy.cjs';

const key = () => fixtureWallet().publicKey.toBase58();
const collector = key(),
  otherCollector = key(),
  treasury = key(),
  maskedConfig = key(),
  mskdConfig = key(),
  legacyConfig = key(),
  masked = key(),
  mskd = key(),
  legacy = key();
const migrations = new URL('../../../../../scripts/migrations/', import.meta.url);
let pg: PGlite, store: WalletStore;

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  let queue = Promise.resolve();
  const query = async (sql: string, args?: unknown[]) => {
    const r = await pg.query(sql, args);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };
  store = new WalletStore({
    query,
    connect: async () => {
      const prior = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => (release = resolve));
      await prior;
      return { query, release } as unknown as PoolClient;
    },
  } as unknown as Pick<Pool, 'query' | 'connect'>);
}, 60_000);
afterAll(async () => pg.close());

beforeEach(async () => {
  await pg.exec('DROP SCHEMA public CASCADE;CREATE SCHEMA public;');
  for (const file of readdirSync(migrations)
    .filter((name) => /^\d{3}-[a-z0-9-]+\.sql$/.test(name))
    .sort())
    await pg.exec(readFileSync(new URL(file, migrations), 'utf8'));
  for (const [config, policy, claimer] of [
    [maskedConfig, 'masked-v1', collector],
    [mskdConfig, 'mskd-v1', collector],
    [legacyConfig, 'mskd-v1', otherCollector],
  ])
    await pg.query(
      `INSERT INTO launch_configs(network_genesis,config_key,policy_version,expected_fee_claimer,expected_leftover_receiver,config_digest,verified_slot)
       VALUES($1,$2,$3,$4,$5,$6,1)`,
      [fixtureGenesis, config, policy, claimer, treasury, 'a'.repeat(64)]
    );
  for (const [mint, config, mode, recipient, share] of [
    [masked, maskedConfig, 'masked', collector, 3000],
    [mskd, mskdConfig, 'mskd', collector, null],
    [legacy, legacyConfig, 'mskd', otherCollector, null],
  ] as const)
    await pg.query(
      `INSERT INTO launch_coins(network_genesis,mint,dbc_pool,config_key,original_deployer,mode,recipient,policy_version,activation_point,activation_time,creation_signature,finalized_slot,creator_share_bps)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,1,$9,1,$10)`,
      [
        fixtureGenesis,
        mint,
        key(),
        config,
        key(),
        mode,
        recipient,
        `${mode}-v1`,
        `c-${mint}`,
        share,
      ]
    );
  await pg.query(
    `INSERT INTO wallet_balances(network_genesis,mint,bucket,funded) VALUES($1,$2,'mskd_buyback',100000000)`,
    [fixtureGenesis, masked]
  );
});

const liability = async () =>
  (
    await pg.query<{ total: string }>(
      'SELECT coalesce(sum(funded-spent),0)::text AS total FROM wallet_balances'
    )
  ).rows[0]!.total;

describe('$MSKD buyback funding', () => {
  it('moves a Masked coin’s accrued share to the $MSKD buyback budget without changing what is owed', async () => {
    const before = await liability();
    expect(await store.transferMskdBuyback(fixtureGenesis, masked, mskd)).toBe(100_000_000n);
    expect(await liability()).toBe(before);
    const buckets = await store.balances(fixtureGenesis, mskd);
    expect(buckets.find((b) => b.bucket === 'rinse_buyback')).toMatchObject({
      available: '100000000',
    });
    expect(await store.transferMskdBuyback(fixtureGenesis, masked, mskd)).toBe(0n);
    expect(
      (await pg.query('SELECT lamports::text FROM masked_mskd_buyback_transfers')).rows
    ).toEqual([{ lamports: '100000000' }]);
  });

  it('refuses coins on another collector, non-Masked sources and $MSKD funding itself', async () => {
    await expect(store.transferMskdBuyback(fixtureGenesis, masked, legacy)).rejects.toThrow(
      'different collector'
    );
    await expect(store.transferMskdBuyback(fixtureGenesis, legacy, mskd)).rejects.toThrow();
    await expect(store.transferMskdBuyback(fixtureGenesis, mskd, mskd)).rejects.toThrow();
  });

  it('burns official $MSKD on mainnet and only a configured stand-in elsewhere', () => {
    expect(mskdBuybackMint(NETWORK_GENESIS['mainnet-beta'])).toBe(OFFICIAL_MSKD.mint);
    expect(mskdBuybackMint(fixtureGenesis, {} as never)).toBeNull();
    expect(mskdBuybackMint(fixtureGenesis, { MASKED_TEST_BUYBACK_MINT: mskd } as never)).toBe(mskd);
  });
});
