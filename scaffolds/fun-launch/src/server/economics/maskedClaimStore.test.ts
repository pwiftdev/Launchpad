import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureGenesis, fixtureWallet } from './financialFixtures';
import { MaskedClaimStore } from './maskedClaimStore';
import { openMoneroAddress } from './moneroSeal';

const env = { MONERO_ADDRESS_KEY: 'ab'.repeat(32) } as unknown as NodeJS.ProcessEnv;
const ADDRESS =
  '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';
const key = () => fixtureWallet().publicKey.toBase58();
const wxmrEnv = {
  ...env,
  MASKED_WXMR_PAYOUTS_ENABLED: 'true',
  MSKD_PAYOUT_POOL: key(),
  MSKD_DEVNET_PAYOUT_MINT: key(),
};
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
afterEach(() => vi.unstubAllEnvs());

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

  it('refuses a stale amount and a wXMR claim below the minimum', async () => {
    await expect(claim({ lamports: 1n })).rejects.toThrow('changed');
    await expect(
      claim({
        currency: 'wxmr',
        env: { ...wxmrEnv, MASKED_MINIMUM_XMR_CLAIM_LAMPORTS: '400000000' },
      })
    ).rejects.toThrow('Earn a little more before claiming in wXMR');
  });

  it.each([
    { MASKED_WXMR_PAYOUTS_ENABLED: 'false' },
    { MSKD_PAYOUT_POOL: '' },
    { MSKD_PAYOUT_POOL: 'invalid' },
    { MSKD_DEVNET_PAYOUT_MINT: '' },
  ])('keeps wXMR disabled with incomplete configuration %o', async (overrides) => {
    const settings = { ...wxmrEnv, ...overrides };
    for (const [name, value] of Object.entries(settings)) vi.stubEnv(name, value);
    expect(await store.earnings(fixtureGenesis, creator)).toMatchObject({ wxmrAvailable: false });
    await expect(claim({ currency: 'wxmr', env: settings })).rejects.toMatchObject({ status: 503 });
    expect((await db.query('SELECT id FROM masked_claims')).rows).toEqual([]);
  });

  it.each([null, true, false])(
    'accepts configured wXMR with native heartbeat %s',
    async (heartbeat) => {
      if (heartbeat !== null)
        await db.query(
          'INSERT INTO masked_payout_status(network_genesis,monero_ok) VALUES($1,$2)',
          [fixtureGenesis, heartbeat]
        );
      for (const [name, value] of Object.entries(wxmrEnv)) vi.stubEnv(name, value);
      expect(await store.earnings(fixtureGenesis, creator)).toMatchObject({ wxmrAvailable: true });
      await expect(
        claim({ currency: 'wxmr', moneroAddress: undefined, env: wxmrEnv })
      ).resolves.toMatchObject({ currency: 'wxmr', status: 'queued' });
      expect((await db.query('SELECT address_sealed,batch_id FROM masked_claims')).rows).toEqual([
        { address_sealed: null, batch_id: null },
      ]);
    }
  );

  it('returns the original wXMR claim after a lost acknowledgement, even if new claims are paused', async () => {
    const requestId = randomUUID();
    const original = await claim({ currency: 'wxmr', requestId, env: wxmrEnv });
    expect(await claim({ currency: 'wxmr', requestId, env })).toEqual(original);
    await expect(
      claim({ currency: 'wxmr', requestId, authorizationDigest: 'f'.repeat(64), env: wxmrEnv })
    ).rejects.toThrow('conflicts');
    expect((await db.query('SELECT id FROM masked_claims')).rows).toEqual([{ id: original.id }]);
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

  it.each(['paid', 'failed'] as const)(
    'allows a wXMR claim after a legacy SOL claim is %s',
    async (status) => {
      const original = await claim({ currency: 'sol', moneroAddress: undefined });
      if (status === 'paid') {
        await db.query(`UPDATE wallet_jobs SET status='finalized',transaction_base64='test',
        message_digest=repeat('d',64),prepared_slot=1,last_valid_block_height=2,
        signature=id::text,finalized_slot=2`);
        await db.query('UPDATE wallet_balances SET spent=reserved,reserved=0 WHERE mint=$1', [
          mintA,
        ]);
      } else {
        await db.query("UPDATE wallet_jobs SET status='failed'");
        await db.query("UPDATE wallet_balances SET reserved=0 WHERE bucket='creator'");
      }
      await db.query(
        "UPDATE wallet_balances SET funded=funded+100000000 WHERE mint=$1 AND bucket='creator'",
        [mintA]
      );
      const view = await store.earnings(fixtureGenesis, creator);
      expect(view).toMatchObject({ openClaim: null, history: [{ id: original.id, status }] });
      await expect(
        claim({
          currency: 'wxmr',
          moneroAddress: undefined,
          lamports: BigInt(view.totalLamports),
          env: wxmrEnv,
        })
      ).resolves.toMatchObject({ currency: 'wxmr', status: 'queued' });
      expect(
        (await db.query('SELECT status FROM masked_claims WHERE id=$1', [original.id])).rows
      ).toEqual([{ status }]);
    }
  );

  it('keeps a SOL claim open while even one payout job is unresolved', async () => {
    await claim({ currency: 'sol', moneroAddress: undefined });
    await db.query("UPDATE wallet_jobs SET status='failed' WHERE kind='creator_claim'");
    await db.query("UPDATE wallet_balances SET reserved=0 WHERE bucket='creator'");
    const view = await store.earnings(fixtureGenesis, creator);
    expect(view.openClaim).toMatchObject({ status: 'sent' });
    await expect(
      claim({ currency: 'wxmr', lamports: BigInt(view.totalLamports), env: wxmrEnv })
    ).rejects.toMatchObject({
      message: 'Your previous claim is still being paid',
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
