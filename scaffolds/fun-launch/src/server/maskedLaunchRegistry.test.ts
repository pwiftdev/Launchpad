import { readdirSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { Keypair } from '@solana/web3.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const databaseMock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('./database', () => ({ database: () => databaseMock }));
import { recordFinalizedLaunch, reserveLaunchIntent, type RegisteredCoin } from './launchRegistry';

const genesis = 'masked-fixture-genesis';
const key = () => Keypair.generate().publicKey.toBase58();
const config = key(),
  devConfig = key(),
  collector = key(),
  treasury = key();
const migrations = new URL('../../../../scripts/migrations/', import.meta.url);

let db: PGlite;
beforeAll(async () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://fixture/fixture');
  // Like node-postgres, return bigint columns as strings.
  db = new PGlite({ parsers: { 20: (value: string) => value } });
  await db.waitReady;
  for (const file of readdirSync(migrations)
    .filter((name) => /^\d{3}-[a-z0-9-]+\.sql$/.test(name))
    .sort())
    await db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  for (const [configKey, policy] of [
    [config, 'masked-v1'],
    [devConfig, 'dev-v1'],
  ])
    await db.query(
      `INSERT INTO launch_configs(network_genesis,config_key,policy_version,expected_fee_claimer,expected_leftover_receiver,config_digest,verified_slot,enabled_for_launch)
       VALUES($1,$2,$3,$4,$5,$6,1,true)`,
      [genesis, configKey, policy, collector, treasury, 'a'.repeat(64)]
    );
  databaseMock.query.mockImplementation((sql: string, args: unknown[]) => db.query(sql, args));
}, 60_000);
beforeEach(() => databaseMock.query.mockClear());
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.close();
});

const intent = (mint: string, extra: Partial<Parameters<typeof reserveLaunchIntent>[0]> = {}) => ({
  genesis,
  mint,
  configKey: config,
  deployer: key(),
  mode: 'masked' as const,
  creatorShareBps: 3000,
  payloadDigest: 'b'.repeat(64),
  preparedSlot: 10,
  ...extra,
});
const coin = (
  mint: string,
  deployer: string,
  extra: Partial<RegisteredCoin> = {}
): RegisteredCoin => ({
  network_genesis: genesis,
  mint,
  dbc_pool: key(),
  config_key: config,
  original_deployer: deployer,
  mode: 'masked',
  recipient: collector,
  policy_version: 'masked-v1',
  activation_point: '100',
  activation_time: '1800000000',
  creation_signature: 'c'.repeat(88),
  finalized_slot: '11',
  creator_share_bps: 3000,
  ...extra,
});

describe('Masked launch registry', () => {
  it('stores the creator share with the intent and the finalized coin, and never changes it', async () => {
    const mint = key();
    const saved = await reserveLaunchIntent(intent(mint));
    expect(saved.creator_share_bps).toBe(3000);
    await expect(
      reserveLaunchIntent({ ...intent(mint), deployer: saved.deployer, creatorShareBps: 7000 })
    ).rejects.toThrow('conflicts');
    const registered = await recordFinalizedLaunch(coin(mint, saved.deployer));
    expect(registered.creator_share_bps).toBe(3000);
    await expect(
      recordFinalizedLaunch(coin(mint, saved.deployer, { creator_share_bps: 10_000 }))
    ).rejects.toThrow('immutable registry');
    await expect(
      db.query('UPDATE launch_coins SET creator_share_bps=10000 WHERE mint=$1', [mint])
    ).rejects.toThrow();
  });

  it('accepts only 10% steps, requires a share for Masked and refuses one on other modes', async () => {
    for (const creatorShareBps of [2500, -1000, 11_000])
      await expect(reserveLaunchIntent(intent(key(), { creatorShareBps }))).rejects.toThrow();
    await expect(
      reserveLaunchIntent(intent(key(), { creatorShareBps: undefined }))
    ).rejects.toThrow();
    await expect(
      reserveLaunchIntent(intent(key(), { configKey: devConfig, mode: 'dev', creatorShareBps: 0 }))
    ).rejects.toThrow();
    await expect(
      reserveLaunchIntent(
        intent(key(), { configKey: devConfig, mode: 'dev', creatorShareBps: undefined })
      )
    ).resolves.toMatchObject({ creator_share_bps: null });
  });

  it('pays Masked fees through the registered collector, never the creator directly', async () => {
    const mint = key();
    const saved = await reserveLaunchIntent(intent(mint));
    await expect(
      recordFinalizedLaunch(coin(mint, saved.deployer, { recipient: saved.deployer }))
    ).rejects.toThrow();
    await expect(recordFinalizedLaunch(coin(mint, saved.deployer))).resolves.toMatchObject({
      recipient: collector,
    });
  });
});
