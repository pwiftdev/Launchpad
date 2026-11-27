import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixtureGenesis, fixtureWallet } from './financialFixtures';
import { MaskedClaimStore } from './maskedClaimStore';
import {
  MAXIMUM_WXMR_ATTEMPTS,
  nextWxmrPayment,
  queueWxmrPayments,
  settleWxmrPayment,
  type WxmrAlert,
} from './maskedWxmrClaims';
import type { WalletEffectFacts, WalletJob } from './walletTypes';

const key = () => fixtureWallet().publicKey.toBase58();
const creator = key(),
  collector = key(),
  treasury = key(),
  config = key(),
  mint = key(),
  second = key(),
  assetMint = key(),
  market = key();
const SOL = 1_000_000_000n;
const migrations = new URL('../../../../../scripts/migrations/', import.meta.url);
const env = { MASKED_WXMR_PAYOUTS_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv;

let pg: PGlite, db: Pick<Pool, 'query' | 'connect'>;
const query = async (sql: string, args?: unknown[]) => {
  const r = await pg.query(sql, args);
  return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
};
const client = { query } as unknown as PoolClient;
beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  let queue = Promise.resolve();
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
  await pg.close();
});

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
  for (const coin of [mint, second])
    await pg.query(
      `INSERT INTO launch_coins(network_genesis,mint,dbc_pool,config_key,original_deployer,mode,recipient,policy_version,activation_point,activation_time,creation_signature,finalized_slot,creator_share_bps)
       VALUES($1,$2,$3,$4,$5,'masked',$6,'masked-v1',1,1,$7,1,5000)`,
      [fixtureGenesis, coin, key(), config, creator, collector, `creation-${coin}`]
    );
  // 1.2 SOL creator share on the first coin, 0.3 SOL on the second; 0.2 SOL of holder reward.
  await pg.query(
    `INSERT INTO wallet_balances(network_genesis,mint,bucket,funded,reserved) VALUES
     ($1,$2,'creator',1200000000,0),($1,$2,'community',200000000,200000000),($1,$3,'creator',300000000,0)`,
    [fixtureGenesis, mint, second]
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
  await new MaskedClaimStore(db).requestClaim({
    networkGenesis: fixtureGenesis,
    wallet: creator,
    currency: 'wxmr',
    lamports: 1_700_000_000n,
    requestId: randomUUID(),
    authorizationDigest: 'c'.repeat(64),
    xmrAvailable: false,
    env,
  });
});

const queueInput = (alerts: WxmrAlert[] = []) => ({
  network: fixtureGenesis,
  collector,
  assetMint,
  market,
  alert: (alert: WxmrAlert) => alerts.push(alert),
});
const job = async (id: string) =>
  (await pg.query<WalletJob>('SELECT *,lamports::text FROM wallet_jobs WHERE id=$1', [id]))
    .rows[0]!;
const effect = (paid: WalletJob, units: bigint): WalletEffectFacts =>
  ({
    kind: 'wxmr_claim',
    networkGenesis: fixtureGenesis,
    mint: paid.mint,
    signature: `sig-${paid.id}`,
    slot: 50,
    transactionIndex: 0,
    messageDigest: 'd'.repeat(64),
    recipient: creator,
    paidLamports: BigInt(paid.lamports),
    collectorDebitLamports: BigInt(paid.lamports),
    receivedPayoutUnits: units,
  }) as unknown as WalletEffectFacts;
const balances = async () =>
  Object.fromEntries(
    (
      await pg.query<{ mint: string; bucket: string; reserved: string; spent: string }>(
        `SELECT mint,bucket,reserved::text,spent::text FROM wallet_balances ORDER BY mint,bucket`
      )
    ).rows.map((row) => [
      `${row.mint === mint ? 'first' : 'second'}:${row.bucket}`,
      [row.reserved, row.spent],
    ])
  );
const claim = async () =>
  (
    await pg.query<{ status: string; xmr_atomic: string | null }>(
      'SELECT status,xmr_atomic::text FROM masked_claims'
    )
  ).rows[0]!;

describe('wXMR payment sizes', () => {
  it('pays in one swap when it fits, and never leaves a tiny last payment', () => {
    expect(nextWxmrPayment(400_000_000n)).toBe(400_000_000n);
    expect(nextWxmrPayment(SOL)).toBe(SOL);
    expect(nextWxmrPayment(1_700_000_000n)).toBe(850_000_000n);
    expect(nextWxmrPayment(1_000_000_001n)).toBe(500_000_001n);
    expect(nextWxmrPayment(3_500_000_000n)).toBe(SOL);
    expect(() => nextWxmrPayment(0n)).toThrow();
  });
});

describe('Masked wXMR claims', () => {
  it('pays a claim in swaps one at a time and settles every coin it drew on', async () => {
    const [first] = await queueWxmrPayments(client, queueInput());
    expect(await queueWxmrPayments(client, queueInput())).toEqual([]);
    const one = await job(first!);
    expect(one).toMatchObject({
      kind: 'wxmr_claim',
      mint: [mint, second].sort()[0],
      recipient: creator,
      bucket: null,
      lamports: '850000000',
      status: 'queued',
    });
    expect(one.details).toMatchObject({ collector, assetMint, market });
    expect(await claim()).toMatchObject({ status: 'sent' });

    await settleWxmrPayment(client, one, effect(one, 400_000_000_000n));
    // Stands in for the finalized job leaving the active set.
    await pg.query(`UPDATE wallet_jobs SET status='failed' WHERE id=$1`, [first]);
    // Replaying the same verified payment changes nothing.
    await settleWxmrPayment(client, one, effect(one, 400_000_000_000n));
    expect(await claim()).toMatchObject({ status: 'sent', xmr_atomic: null });

    const [next] = await queueWxmrPayments(client, queueInput());
    const two = await job(next!);
    expect(two.lamports).toBe('850000000');
    await settleWxmrPayment(client, two, effect(two, 399_000_000_000n));
    expect(await claim()).toEqual({ status: 'paid', xmr_atomic: '799000000000' });
    expect(await balances()).toEqual({
      'first:community': ['0', '200000000'],
      'first:creator': ['0', '1200000000'],
      'second:creator': ['0', '300000000'],
    });
    expect(await queueWxmrPayments(client, queueInput())).toEqual([]);
  });

  it('refuses a payment for more than the claim still owes', async () => {
    const [first] = await queueWxmrPayments(client, queueInput());
    const forged = { ...(await job(first!)), lamports: '1800000000' };
    await expect(settleWxmrPayment(client, forged, effect(forged, 1n))).rejects.toThrow(
      'exceeds what the claim reserved'
    );
  });

  it('returns the earnings after repeated failed payments when nothing was paid', async () => {
    const alerts: WxmrAlert[] = [];
    for (let attempt = 0; attempt < MAXIMUM_WXMR_ATTEMPTS; attempt++) {
      const [id] = await queueWxmrPayments(client, queueInput(alerts));
      await pg.query(`UPDATE wallet_jobs SET status='failed' WHERE id=$1`, [id]);
    }
    expect(await queueWxmrPayments(client, queueInput(alerts))).toEqual([]);
    expect(alerts).toMatchObject([{ level: 'warning' }]);
    expect(await claim()).toMatchObject({ status: 'failed' });
    expect(await balances()).toMatchObject({
      'first:creator': ['0', '0'],
      'second:creator': ['0', '0'],
    });
    const earnings = await new MaskedClaimStore(db).earnings(fixtureGenesis, creator);
    expect(earnings).toMatchObject({ totalLamports: '1700000000', openClaim: null });
  });

  it('leaves a claim on coins of another company wallet for review', async () => {
    const alerts: WxmrAlert[] = [];
    expect(await queueWxmrPayments(client, { ...queueInput(alerts), collector: key() })).toEqual(
      []
    );
    expect(alerts).toMatchObject([{ level: 'critical' }]);
    expect(await claim()).toMatchObject({ status: 'queued' });
  });
});
