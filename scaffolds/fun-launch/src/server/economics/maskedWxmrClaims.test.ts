import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  fixtureGenesis,
  fixtureWallet,
  transactionFixture,
  unsignedTransaction,
} from './financialFixtures';
import { messageDigest } from './chainEvidence';
import { MaskedClaimStore } from './maskedClaimStore';
import {
  MAXIMUM_WXMR_ATTEMPTS,
  nextWxmrPayment,
  queueWxmrPayments,
  settleWxmrPayment,
  type WxmrAlert,
} from './maskedWxmrClaims';
import type { WalletEffectFacts, WalletJob } from './walletTypes';
import { WalletStore } from './walletStore';

const verified = vi.hoisted(() => new WeakSet<object>());
vi.mock('./walletEvidence', async (load) => ({
  ...(await load<typeof import('./walletEvidence')>()),
  assertVerifiedWalletEffect: (evidence: object) => {
    if (!verified.has(evidence)) throw new Error('Verified effect required');
  },
}));

const key = () => fixtureWallet().publicKey.toBase58();
const signingCollector = fixtureWallet();
const creator = key(),
  collector = signingCollector.publicKey.toBase58(),
  treasury = key(),
  config = key(),
  mint = key(),
  second = key(),
  assetMint = key(),
  market = key();
const SOL = 1_000_000_000n;
const migrations = new URL('../../../../../scripts/migrations/', import.meta.url);
const env = {
  NODE_ENV: 'test',
  MASKED_WXMR_PAYOUTS_ENABLED: 'true',
  MSKD_DEVNET_PAYOUT_MINT: assetMint,
  MSKD_PAYOUT_POOL: market,
} satisfies NodeJS.ProcessEnv;

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

async function recordSignedPayment(job: WalletJob, evidence: WalletEffectFacts) {
  await pg.query(
    `UPDATE wallet_jobs SET status='signed',transaction_base64='fixture',message_digest=$2,
     prepared_slot=1,last_valid_block_height=2,signature=$3 WHERE id=$1`,
    [job.id, evidence.messageDigest, evidence.signature]
  );
  verified.add(evidence);
}

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
  it('replaces only the expected unsigned quote and preserves a signed attempt through a retry', async () => {
    const store = new WalletStore(db);
    const [id] = await store.queueMaskedWxmrPayments(queueInput());
    const claimJob = await job(id!);
    const quote = () => {
      const { tx } = transactionFixture(
        [
          SystemProgram.transfer({
            fromPubkey: signingCollector.publicKey,
            toPubkey: new PublicKey(creator),
            lamports: 1,
          }),
        ],
        signingCollector
      );
      return {
        signed: Buffer.from(tx.serialize()).toString('base64'),
        prepared: {
          networkGenesis: fixtureGenesis,
          mint: claimJob.mint,
          kind: claimJob.kind,
          transactionBase64: unsignedTransaction(tx),
          messageDigest: messageDigest(tx.serializeMessage()),
          preparedSlot: 900,
          lastValidBlockHeight: 1100,
          expectations: {
            collector,
            pool: market,
            recipient: creator,
            payoutMint: assetMint,
            expectedLamports: claimJob.lamports,
            maximumSpendLamports: claimJob.lamports,
            maximumFeeLamports: '5000',
            operatingCostLamports: '5000',
          },
        },
      };
    };
    const initial = quote(),
      replacement = quote();
    await store.prepareJob(id!, initial.prepared);
    await store.prepareJob(id!, replacement.prepared, initial.prepared.messageDigest);
    await expect(store.attachSigned(id!, initial.signed)).rejects.toThrow();
    await store.attachSigned(id!, replacement.signed);
    const after = await new WalletStore(db).prepareJob(
      id!,
      quote().prepared,
      replacement.prepared.messageDigest
    );
    expect(after).toMatchObject({
      status: 'signed',
      transaction_base64: replacement.signed,
      message_digest: replacement.prepared.messageDigest,
    });
  });
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

  it('reuses the signed payment after a restart and rolls back a failed local settlement', async () => {
    const [id] = await queueWxmrPayments(client, queueInput());
    const payment = await job(id!);
    const evidence = effect(payment, 400_000_000_000n);
    await recordSignedPayment(payment, evidence);
    const before = await balances();
    await pg.exec(`
      CREATE FUNCTION fail_wxmr_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status='finalized' THEN RAISE EXCEPTION 'settlement write failed'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_wxmr_settlement BEFORE UPDATE ON wallet_jobs
        FOR EACH ROW EXECUTE FUNCTION fail_wxmr_settlement();
    `);
    await expect(new WalletStore(db).settle(id!, evidence)).rejects.toThrow(
      'settlement write failed'
    );
    expect(await balances()).toEqual(before);
    expect((await pg.query('SELECT job_id FROM masked_wxmr_payments')).rows).toEqual([]);
    expect(await job(id!)).toMatchObject({ status: 'signed', signature: evidence.signature });
    expect(await queueWxmrPayments(client, queueInput())).toEqual([]);

    await pg.exec('DROP TRIGGER fail_wxmr_settlement ON wallet_jobs');
    const restartedStore = new WalletStore(db);
    expect(await restartedStore.settle(id!, evidence)).toMatchObject({ status: 'finalized' });
    const settled = await balances();
    await restartedStore.settle(id!, evidence);
    expect(await balances()).toEqual(settled);
    const [next] = await queueWxmrPayments(client, queueInput());
    expect(await job(next!)).toMatchObject({ lamports: '850000000' });
  });

  it('queues a new claim behind 50 older claims with active jobs', async () => {
    await pg.query(
      `WITH old_claims AS (
        INSERT INTO masked_claims(id,network_genesis,wallet,currency,lamports,request_id,authorization_digest,status,created_at)
        SELECT gen_random_uuid(),$1,md5(n::text),'wxmr',50000000,gen_random_uuid(),repeat('a',64),'sent',now()-interval '1 day'
        FROM generate_series(1,50) n RETURNING id,wallet
      )
      INSERT INTO wallet_jobs(id,network_genesis,mint,kind,intent_key,recipient,lamports,details)
      SELECT gen_random_uuid(),$1,$2,'wxmr_claim',id::text,wallet,50000000,jsonb_build_object('maskedClaim',id::text)
      FROM old_claims`,
      [fixtureGenesis, mint]
    );
    const [id] = await queueWxmrPayments(client, queueInput());
    expect(await job(id!)).toMatchObject({ recipient: creator, lamports: '850000000' });
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

  it('keeps the unpaid part reserved for review after consecutive failures', async () => {
    const alerts: WxmrAlert[] = [];
    const store = new WalletStore(db);
    const [first] = await queueWxmrPayments(client, queueInput());
    const payment = await job(first!);
    const evidence = effect(payment, 400_000_000_000n);
    await recordSignedPayment(payment, evidence);
    await store.settle(first!, evidence);
    const afterFirst = await balances();

    const failures: string[] = [];
    for (let attempt = 0; attempt < MAXIMUM_WXMR_ATTEMPTS; attempt++) {
      const [id] = await queueWxmrPayments(client, queueInput(alerts));
      failures.push(id!);
      await pg.query("UPDATE wallet_jobs SET status='failed' WHERE id=$1", [id]);
    }
    expect(await queueWxmrPayments(client, queueInput(alerts))).toEqual([]);
    expect(await queueWxmrPayments(client, queueInput(alerts))).toEqual([]);
    expect(alerts).toMatchObject([{ level: 'critical' }]);
    expect(await balances()).toEqual(afterFirst);
    expect(await new MaskedClaimStore(db).earnings(fixtureGenesis, creator)).toMatchObject({
      totalLamports: '0',
      openClaim: { status: 'sent', failure: 'A partially paid claim needs review' },
    });
    const resume = (id: string, owner = collector) =>
      new WalletStore(db).resumeMaskedWxmrClaim(fixtureGenesis, owner, id);
    expect(await resume(failures[0]!)).toBeNull();
    expect(await resume(failures.at(-1)!, key())).toBeNull();
    expect(await resume(failures.at(-1)!)).toBe(payment.details.maskedClaim);
    // A restart or lost acknowledgement only reads the committed result on retry.
    expect(await resume(failures.at(-1)!)).toBeNull();
    const [next] = await store.queueMaskedWxmrPayments(queueInput());
    expect(await job(next!)).toMatchObject({ lamports: '850000000' });
    expect(await store.queueMaskedWxmrPayments(queueInput())).toEqual([]);
    expect(await balances()).toEqual(afterFirst);
    const remaining = await job(next!);
    const settled = effect(remaining, 300_000_000_000n);
    await recordSignedPayment(remaining, settled);
    await store.settle(next!, settled);
    expect(await claim()).toEqual({ status: 'paid', xmr_atomic: '700000000000' });
  });

  it('leaves a claim on another company wallet for its own worker', async () => {
    const alerts: WxmrAlert[] = [];
    expect(await queueWxmrPayments(client, { ...queueInput(alerts), collector: key() })).toEqual(
      []
    );
    expect(alerts).toEqual([]);
    expect(await claim()).toMatchObject({ status: 'queued' });
  });
});
