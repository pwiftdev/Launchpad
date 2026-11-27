import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureGenesis, fixtureWallet } from './financialFixtures';
import { MaskedClaimStore } from './maskedClaimStore';
import { MaskedXmrPayouts } from './maskedXmrPayouts';
import type { MoneroWallet } from './moneroWallet';

const key = () => fixtureWallet().publicKey.toBase58();
const ADDRESS =
  '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';
const creator = key(),
  collector = key(),
  treasury = key(),
  config = key(),
  mint = key();
const migrations = new URL('../../../../../scripts/migrations/', import.meta.url);
// 0.5 XMR per SOL at the market, 1% fee: 0.495 XMR per SOL of earnings.
const price = async () => ({ solUsd: 150, xmrUsd: 300, source: 'test', at: new Date() });
const RATE = 495_000_000_000n;

let pg: PGlite, db: Pick<Pool, 'query' | 'connect'>;
beforeAll(async () => {
  vi.stubEnv('MONERO_ADDRESS_KEY', 'cd'.repeat(32));
  pg = new PGlite();
  await pg.waitReady;
  let queue = Promise.resolve();
  const query = async (sql: string, args?: unknown[]) => {
    const r = await pg.query(sql, args);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };
  db = {
    query,
    connect: async () => {
      const prior = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => (release = resolve));
      await prior;
      return { query, release } as unknown as PoolClient;
    },
  } as unknown as Pick<Pool, 'query' | 'connect'>;
}, 60_000);
afterAll(async () => {
  vi.unstubAllEnvs();
  await pg.close();
});

function fakeWallet(unlocked = 10_000_000_000_000n) {
  const state = { unlocked, confirmations: 0, failed: false, relayed: [] as string[], signed: 0 };
  const wallet = {
    height: vi.fn(async () => 3_000_000),
    balance: vi.fn(async () => ({ balance: state.unlocked, unlocked: state.unlocked })),
    validAddress: vi.fn(async () => true),
    signTransfers: vi.fn(async (destinations: { amount: bigint }[]) => {
      state.signed++;
      return {
        txHashes: ['tx-1'],
        txMetadata: ['signed-tx-1'],
        amounts: [destinations.reduce((sum, d) => sum + d.amount, 0n)],
        fees: [30_000_000n],
      };
    }),
    relay: vi.fn(async (metadata: string) => {
      state.relayed.push(metadata);
      return 'tx-1';
    }),
    confirmations: vi.fn(async () => ({
      confirmations: state.confirmations,
      failed: state.failed,
    })),
  };
  return { wallet: wallet as unknown as MoneroWallet, state, mock: wallet };
}

beforeEach(async () => {
  await pg.exec('DROP SCHEMA public CASCADE;CREATE SCHEMA public;');
  for (const file of readdirSync(migrations)
    .filter((name) => /^\d{3}-[a-z0-9-]+\.sql$/.test(name))
    .sort())
    await pg.exec(readFileSync(new URL(file, migrations), 'utf8'));
  await pg.query(
    `INSERT INTO launch_configs(network_genesis,config_key,policy_version,expected_fee_claimer,expected_leftover_receiver,config_digest,verified_slot)
     VALUES($1,$2,'masked-v1',$3,$4,$5,1)`,
    [fixtureGenesis, config, collector, treasury, 'a'.repeat(64)]
  );
  await pg.query(
    `INSERT INTO launch_coins(network_genesis,mint,dbc_pool,config_key,original_deployer,mode,recipient,policy_version,activation_point,activation_time,creation_signature,finalized_slot,creator_share_bps)
     VALUES($1,$2,$3,$4,$5,'masked',$6,'masked-v1',1,1,'creation',1,5000)`,
    [fixtureGenesis, mint, key(), config, creator, collector]
  );
  await pg.query(
    `INSERT INTO wallet_balances(network_genesis,mint,bucket,funded,reserved) VALUES
     ($1,$2,'creator',800000000,0),($1,$2,'community',200000000,200000000),($1,$2,'platform',500000000,0)`,
    [fixtureGenesis, mint]
  );
  await pg.query(
    `INSERT INTO wallet_epochs(network_genesis,mint,epoch,snapshot_slot,snapshot_time,snapshot_digest,budget,allocated,carry)
     VALUES($1,$2,10,1,39600,$3,1,1,0)`,
    [fixtureGenesis, mint, 'b'.repeat(64)]
  );
  await pg.query(
    'INSERT INTO wallet_allocations(network_genesis,mint,epoch,wallet,lamports) VALUES($1,$2,10,$3,200000000)',
    [fixtureGenesis, mint, creator]
  );
  // The creator claims 0.8 SOL creator share + 0.2 SOL holder reward = 1 SOL in XMR.
  await new MaskedClaimStore(db).requestClaim({
    networkGenesis: fixtureGenesis,
    wallet: creator,
    currency: 'xmr',
    lamports: 1_000_000_000n,
    requestId: randomUUID(),
    authorizationDigest: 'c'.repeat(64),
    moneroAddress: ADDRESS,
    xmrAvailable: true,
  });
});

const balances = async () =>
  Object.fromEntries(
    (
      await pg.query<{ bucket: string; funded: string; reserved: string; spent: string }>(
        'SELECT bucket,funded::text,reserved::text,spent::text FROM wallet_balances WHERE mint=$1',
        [mint]
      )
    ).rows.map((row) => [row.bucket, [row.funded, row.reserved, row.spent]])
  );

describe('daily XMR payouts', () => {
  it('pays at the locked rate, waits for confirmations and moves the SOL to company income', async () => {
    const { wallet, state, mock } = fakeWallet();
    const payouts = new MaskedXmrPayouts(wallet, price, fixtureGenesis, { db, alert: () => {} });
    expect(await payouts.runOnce(true)).toEqual({ status: 'confirming' });
    expect(mock.signTransfers).toHaveBeenCalledWith([{ address: ADDRESS, amount: RATE }]);
    expect(state.relayed).toEqual(['signed-tx-1']);
    expect(await new MaskedClaimStore(db).xmrAvailable(fixtureGenesis)).toBe(true);
    state.confirmations = 10;
    expect(await payouts.runOnce(false)).toEqual({ status: 'paid' });
    const claim = (
      await pg.query<{ status: string; xmr_atomic: string; address_sealed: unknown }>(
        'SELECT status,xmr_atomic::text,address_sealed FROM masked_claims'
      )
    ).rows[0]!;
    expect(claim).toEqual({ status: 'paid', xmr_atomic: RATE.toString(), address_sealed: null });
    expect(await balances()).toEqual({
      creator: ['800000000', '0', '800000000'],
      community: ['200000000', '0', '200000000'],
      platform: ['1500000000', '0', '0'],
    });
    expect(
      (await pg.query('SELECT bucket,lamports::text FROM masked_xmr_settlements ORDER BY bucket'))
        .rows
    ).toEqual([
      { bucket: 'community', lamports: '200000000' },
      { bucket: 'creator', lamports: '800000000' },
    ]);
    expect((await pg.query('SELECT status,tx_metadata FROM masked_xmr_batches')).rows).toEqual([
      { status: 'paid', tx_metadata: null },
    ]);
  });

  it('after a crash between signing and relaying, resends only the same signed transaction', async () => {
    const { wallet, state, mock } = fakeWallet();
    mock.relay.mockRejectedValueOnce(new Error('connection reset'));
    const payouts = new MaskedXmrPayouts(wallet, price, fixtureGenesis, { db, alert: () => {} });
    await expect(payouts.runOnce(true)).rejects.toThrow('connection reset');
    expect((await pg.query('SELECT status FROM masked_xmr_batches')).rows).toEqual([
      { status: 'signed' },
    ]);
    expect(await payouts.runOnce(true)).toEqual({ status: 'confirming' });
    expect(state.signed).toBe(1);
    expect(state.relayed).toEqual(['signed-tx-1']);
  });

  it('plans nothing and reports the top-up when the treasury cannot cover the batch', async () => {
    const alerts: string[] = [];
    const { wallet } = fakeWallet(RATE);
    const payouts = new MaskedXmrPayouts(wallet, price, fixtureGenesis, {
      db,
      alert: (alert) => alerts.push(alert.message),
    });
    expect(await payouts.runOnce(true)).toMatchObject({
      status: 'top_up_needed',
      deficitAtomic: 20_000_000_000n,
    });
    expect(alerts[0]).toContain('Treasury top-up needed');
    expect((await pg.query('SELECT count(*)::int AS n FROM masked_xmr_batches')).rows).toEqual([
      { n: 0 },
    ]);
  });

  it('returns every earning to the wallet when the whole batch fails', async () => {
    const { wallet, state } = fakeWallet();
    const payouts = new MaskedXmrPayouts(wallet, price, fixtureGenesis, { db, alert: () => {} });
    await payouts.runOnce(true);
    state.failed = true;
    expect(await payouts.runOnce(false)).toEqual({ status: 'failed' });
    expect(await balances()).toMatchObject({
      creator: ['800000000', '0', '0'],
      community: ['200000000', '200000000', '0'],
    });
    const earnings = await new MaskedClaimStore(db).earnings(fixtureGenesis, creator);
    expect(earnings).toMatchObject({ totalLamports: '1000000000', openClaim: null });
    expect(earnings.history[0]).toMatchObject({ status: 'failed' });
  });

  it('reports an unreachable wallet so the claim screen offers wXMR instead', async () => {
    const { wallet, mock } = fakeWallet();
    mock.height.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const payouts = new MaskedXmrPayouts(wallet, price, fixtureGenesis, { db, alert: () => {} });
    expect(await payouts.runOnce(true)).toEqual({ status: 'wallet_unavailable' });
    expect(await new MaskedClaimStore(db).xmrAvailable(fixtureGenesis)).toBe(false);
  });
});
