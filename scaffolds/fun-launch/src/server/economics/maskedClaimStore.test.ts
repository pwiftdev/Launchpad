import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixtureGenesis, fixtureWallet } from './financialFixtures';
import { MaskedClaimStore } from './maskedClaimStore';
import { openMoneroAddress } from './moneroSeal';

const env = { MONERO_ADDRESS_KEY: 'ab'.repeat(32) } as unknown as NodeJS.ProcessEnv;
const ADDRESS =
  '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';
const key = () => fixtureWallet().publicKey.toBase58();
const creator = key(),
  holder = key(),
  collector = key(),
  treasury = key(),
  config = key(),
  mintA = key(),
  mintB = key();
const migrations = new URL('../../../../../scripts/migrations/', import.meta.url);

let db: PGlite, store: MaskedClaimStore;
beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  let queue = Promise.resolve();
  const query = async (sql: string, args?: unknown[]) => {
    const r = await db.query(sql, args);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };
  store = new MaskedClaimStore({
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
afterAll(async () => db.close());

beforeEach(async () => {
  await db.exec('DROP SCHEMA public CASCADE;CREATE SCHEMA public;');
  for (const file of readdirSync(migrations)
    .filter((name) => /^\d{3}-[a-z0-9-]+\.sql$/.test(name))
    .sort())
    await db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  await db.query(
    `INSERT INTO launch_configs(network_genesis,config_key,policy_version,expected_fee_claimer,expected_leftover_receiver,config_digest,verified_slot)
     VALUES($1,$2,'masked-v1',$3,$4,$5,1)`,
    [fixtureGenesis, config, collector, treasury, 'a'.repeat(64)]
  );
  for (const mint of [mintA, mintB])
    await db.query(
      `INSERT INTO launch_coins(network_genesis,mint,dbc_pool,config_key,original_deployer,mode,recipient,policy_version,activation_point,activation_time,creation_signature,finalized_slot,creator_share_bps)
       VALUES($1,$2,$3,$4,$5,'masked',$6,'masked-v1',1,1,$7,1,3000)`,
      [fixtureGenesis, mint, key(), config, creator, collector, `creation-${mint}`]
    );
  // Coin A: 0.3 SOL creator share; the creator also held it for two hours (0.004 + 0.0005 SOL).
  // Coin B: 0.2 SOL to another holder for one hour.
  await db.query(
    `INSERT INTO wallet_balances(network_genesis,mint,bucket,funded,reserved) VALUES
     ($1,$2,'creator',300000000,0),($1,$2,'community',4500000,4500000),($1,$3,'community',200000000,200000000)`,
    [fixtureGenesis, mintA, mintB]
  );
  const epoch = async (mint: string, n: number, rows: [string, number][]) => {
    await db.query(
      `INSERT INTO wallet_epochs(network_genesis,mint,epoch,snapshot_slot,snapshot_time,snapshot_digest,budget,allocated,carry)
       VALUES($1,$2,$3,1,$4,$5,1,1,0)`,
      [fixtureGenesis, mint, n, (n + 1) * 3600, 'b'.repeat(64)]
    );
    for (const [wallet, lamports] of rows)
      await db.query(
        'INSERT INTO wallet_allocations(network_genesis,mint,epoch,wallet,lamports) VALUES($1,$2,$3,$4,$5)',
        [fixtureGenesis, mint, n, wallet, lamports]
      );
  };
  await epoch(mintA, 10, [[creator, 4_000_000]]);
  await epoch(mintA, 11, [[creator, 500_000]]);
  await epoch(mintB, 10, [[holder, 200_000_000]]);
});

const claim = (extra: Partial<Parameters<MaskedClaimStore['requestClaim']>[0]> = {}) =>
  store.requestClaim({
    networkGenesis: fixtureGenesis,
    wallet: creator,
    currency: 'xmr',
    lamports: 304_500_000n,
    requestId: randomUUID(),
    authorizationDigest: 'c'.repeat(64),
    moneroAddress: ADDRESS,
    xmrAvailable: true,
    env,
    ...extra,
  });

describe('Masked earnings and claims', () => {
  it('sums creator and holder earnings across coins, and what SOL can pay right away', async () => {
    const view = await store.earnings(fixtureGenesis, creator);
    expect(view.totalLamports).toBe('304500000');
    expect(view.coins).toEqual([
      { mint: mintA, creatorLamports: '300000000', holderLamports: '4500000', holderHours: 2 },
    ]);
    expect(view.solClaimableLamports).toBe('304500000');
    expect((await store.earnings(fixtureGenesis, holder)).totalLamports).toBe('200000000');
  });

  it('takes everything for an XMR claim, seals the address and blocks a second open claim', async () => {
    const result = await claim();
    expect(result).toMatchObject({ currency: 'xmr', lamports: '304500000', status: 'queued' });
    const row = (
      await db.query<{ id: string; address_sealed: Uint8Array }>(
        'SELECT id,address_sealed FROM masked_claims'
      )
    ).rows[0]!;
    expect(openMoneroAddress(row.id, Buffer.from(row.address_sealed), env)).toBe(ADDRESS);
    expect(Buffer.from(row.address_sealed).toString('utf8')).not.toContain(ADDRESS.slice(0, 20));
    const creatorBucket = (
      await db.query<{ reserved: string }>(
        "SELECT reserved::text FROM wallet_balances WHERE mint=$1 AND bucket='creator'",
        [mintA]
      )
    ).rows[0]!;
    expect(creatorBucket.reserved).toBe('300000000');
    const after = await store.earnings(fixtureGenesis, creator);
    expect(after).toMatchObject({ totalLamports: '0', openClaim: { status: 'queued' } });
    await expect(claim({ lamports: 1n })).rejects.toThrow();
  });

  it('refuses a stale amount, a small XMR claim and the wrong payout route', async () => {
    await expect(claim({ lamports: 1n })).rejects.toThrow('changed');
    await expect(
      claim({ env: { ...env, MASKED_MINIMUM_XMR_CLAIM_LAMPORTS: '400000000' } })
    ).rejects.toThrow('a little more');
    await expect(claim({ currency: 'wxmr', moneroAddress: undefined })).rejects.toThrow(
      'only while native XMR payouts are down'
    );
    // wXMR stays off until its payout job exists, even while XMR is down.
    await expect(
      claim({ currency: 'wxmr', moneroAddress: undefined, xmrAvailable: false })
    ).rejects.toThrow('only while native XMR payouts are down');
    await expect(
      claim({
        currency: 'wxmr',
        moneroAddress: undefined,
        xmrAvailable: false,
        env: { ...env, MASKED_WXMR_PAYOUTS_ENABLED: 'true' },
      })
    ).resolves.toMatchObject({ currency: 'wxmr' });
  });

  it('pays SOL as one creator and one holder payout job per coin, even for a creator who holds', async () => {
    const result = await claim({ currency: 'sol', moneroAddress: undefined });
    expect(result).toMatchObject({ currency: 'sol', status: 'sent' });
    const jobs = (
      await db.query<{ kind: string; lamports: string; epoch: string | null; recipient: string }>(
        'SELECT kind,lamports::text,epoch::text,recipient FROM wallet_jobs ORDER BY kind'
      )
    ).rows;
    expect(jobs).toEqual([
      { kind: 'community_claim', lamports: '4500000', epoch: '11', recipient: creator },
      { kind: 'creator_claim', lamports: '300000000', epoch: null, recipient: creator },
    ]);
    expect(
      (await db.query('SELECT epoch::text FROM wallet_claim_allocations ORDER BY epoch')).rows
    ).toEqual([{ epoch: '10' }, { epoch: '11' }]);
    expect((await store.earnings(fixtureGenesis, creator)).totalLamports).toBe('0');
  });

  it('queues an XMR claim while the payout wallet is down', async () => {
    await expect(claim({ xmrAvailable: false })).resolves.toMatchObject({
      currency: 'xmr',
      status: 'queued',
    });
  });

  it('never lets XMR and SOL claims take the same hour', async () => {
    await claim({ wallet: holder, lamports: 200_000_000n });
    expect((await store.earnings(fixtureGenesis, holder)).solClaimableLamports).toBe('0');
    await expect(
      claim({ wallet: holder, currency: 'sol', moneroAddress: undefined, lamports: 200_000_000n })
    ).rejects.toThrow();
  });

  it('keeps claim terms fixed and lets an address only be erased', async () => {
    await claim();
    await expect(db.query('UPDATE masked_claims SET lamports=1')).rejects.toThrow('immutable');
    await expect(db.query("UPDATE masked_claims SET address_sealed='\\x00'")).rejects.toThrow(
      'only be erased'
    );
    await expect(db.query("UPDATE masked_claims SET status='paid'")).rejects.toThrow();
    await expect(db.query('DELETE FROM masked_claims')).rejects.toThrow('permanent');
  });
});
