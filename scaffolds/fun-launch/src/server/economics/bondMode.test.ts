import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { Pool, PoolClient } from 'pg';
import { SystemProgram } from '@solana/web3.js';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { WalletStore } from './walletStore';
import { FinalizedVerifier, messageDigest } from './chainEvidence';
import {
  fixtureGenesis,
  fixtureWallet,
  transactionFixture,
  unsignedTransaction,
} from './financialFixtures';
import type { WalletEffectFacts, WalletJob } from './walletTypes';

const proofs = vi.hoisted(() => new WeakSet<object>());
vi.mock('./walletEvidence', () => ({
  assertVerifiedWalletEffect: (effect: object) => {
    if (!proofs.has(effect)) throw new Error('Finalized effect required');
  },
}));

const collector = fixtureWallet(),
  treasury = fixtureWallet(),
  creator = fixtureWallet();
const mint = fixtureWallet().publicKey.toBase58(),
  pool = fixtureWallet().publicKey.toBase58();
const config = fixtureWallet().publicKey.toBase58(),
  damm = fixtureWallet().publicKey.toBase58();
const migrations = [
  '003-launch-registry.sql',
  '017-wallet-settlement.sql',
  '018-wallet-hourly-processing.sql',
  '019-wallet-settlement-receipts.sql',
  '024-bond-it-policy.sql',
];
const migration = (name: string) =>
  readFileSync(new URL(`../../../../../scripts/migrations/${name}`, import.meta.url), 'utf8');
let db: PGlite, store: WalletStore;
beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  const query = async (sql: string, args?: unknown[]) => {
    const result = await db.query(sql, args);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  store = new WalletStore({
    query,
    connect: async () => ({ query, release: () => {} }) as unknown as PoolClient,
  } as Pick<Pool, 'query' | 'connect'>);
}, 20000);
beforeEach(async () => {
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const file of migrations) await db.exec(migration(file));
  await db.query(
    `INSERT INTO launch_configs(network_genesis,config_key,policy_version,expected_fee_claimer,expected_leftover_receiver,config_digest,verified_slot)
    VALUES($1,$2,'bond-v1',$3,$4,$5,1)`,
    [
      fixtureGenesis,
      config,
      collector.publicKey.toBase58(),
      treasury.publicKey.toBase58(),
      'a'.repeat(64),
    ]
  );
  await db.query(
    `INSERT INTO launch_coins(network_genesis,mint,dbc_pool,config_key,original_deployer,mode,recipient,policy_version,activation_point,activation_time,creation_signature,finalized_slot)
    VALUES($1,$2,$3,$4,$5,'bond',$5,'bond-v1',900,1800000000,'creation',900)`,
    [fixtureGenesis, mint, pool, config, creator.publicKey.toBase58()]
  );
});
afterAll(async () => db.close());

async function seedEvent(net: bigint, phase: 0 | 1 = 0) {
  await db.query(
    `INSERT INTO wallet_fee_events(network_genesis,mint,pool,signature,instruction_index,event_index,finalized_slot,trade_time,phase,total,protocol,referral,net,event_digest)
    VALUES($1,$2,$3,$4,0,1,950,1800000300,$5,$6,0,0,$6,$7)`,
    [
      fixtureGenesis,
      mint,
      phase === 0 ? pool : damm,
      randomUUID(),
      phase,
      net.toString(),
      'b'.repeat(64),
    ]
  );
  if (phase === 1)
    await db.query(
      `INSERT INTO wallet_index_cursors(network_genesis,pool,complete,finalized_slot)VALUES($1,$2,true,1000)ON CONFLICT(network_genesis,pool)DO UPDATE SET finalized_slot=1000`,
      [fixtureGenesis, damm]
    );
}
async function sign(job: WalletJob, expectedLamports?: bigint, costs: Record<string, string> = {}) {
  const fixture = transactionFixture(
    [
      SystemProgram.transfer({
        fromPubkey: collector.publicKey,
        toPubkey: treasury.publicKey,
        lamports: 1,
      }),
    ],
    collector
  );
  await store.prepareJob(job.id, {
    networkGenesis: fixtureGenesis,
    mint,
    kind: job.kind,
    transactionBase64: unsignedTransaction(fixture.tx),
    messageDigest: messageDigest(fixture.tx.serializeMessage()),
    preparedSlot: 900,
    lastValidBlockHeight: 1100,
    expectations: {
      collector: collector.publicKey.toBase58(),
      pool: String(job.details.pool ?? pool),
      maximumFeeLamports: '5000',
      operatingCostLamports: '5000',
      expectedLamports: expectedLamports?.toString(),
      ...costs,
    },
  });
  return {
    fixture,
    job: await store.attachSigned(job.id, fixture.tx.serialize().toString('base64')),
  };
}
function effect(job: WalletJob, extra: Partial<WalletEffectFacts> = {}) {
  const result = {
    networkGenesis: fixtureGenesis,
    mint,
    kind: job.kind,
    signature: job.signature!,
    slot: 1000,
    transactionIndex: 0,
    slotSignatures: [job.signature!],
    messageDigest: job.message_digest!,
    operatingCostLamports: 5000n,
    ...extra,
  } as WalletEffectFacts;
  proofs.add(result);
  return result;
}
async function collect(net: bigint, phase: 0 | 1 = 0) {
  await seedEvent(net, phase);
  const events = (await store.pendingFeeEvents(fixtureGenesis, mint)).filter(
    (e) => e.pool === (phase === 0 ? pool : damm)
  );
  const { job } = await sign(await store.queueCollection(fixtureGenesis, mint, events), net);
  const receipt = effect(job, { receivedLamports: net });
  await store.settle(job.id, receipt);
  return { job, receipt };
}
async function balances() {
  return Object.fromEntries(
    (await store.balances(fixtureGenesis, mint)).map((row) => [row.bucket, BigInt(row.available)])
  );
}

it('allocates late DBC income entirely to buybacks and operations and charges execution once', async () => {
  const { job, receipt } = await collect(1_000_000n);
  expect(await balances()).toMatchObject({
    rinse_buyback: 950_000n,
    creator: 0n,
    community: 0n,
    platform: 45_000n,
  });
  await store.settle(job.id, receipt);
  expect((await balances()).platform).toBe(45_000n);
  expect((await db.query('SELECT lamports::text FROM wallet_operating_costs')).rows).toEqual([
    { lamports: '5000' },
  ]);
  await expect(db.exec('DELETE FROM wallet_operating_costs')).rejects.toThrow('append-only');
});

it('switches only for DAMM receipts, retains old buyback funds, and pays only the original creator', async () => {
  await collect(100_000_000n);
  await collect(8_000_000n, 1);
  expect(await balances()).toMatchObject({
    rinse_buyback: 95_000_000n,
    creator: 5_000_000n,
    community: 0n,
    platform: 7_990_000n,
  });
  const view = await store.rewardsView({
    networkGenesis: fixtureGenesis,
    mint,
    wallet: creator.publicKey.toBase58(),
  });
  expect(view.mode).toBe('bond');
  expect(view.availableLamports).toBe('5000000');
  await expect(
    store.requestClaim({
      networkGenesis: fixtureGenesis,
      mint,
      wallet: treasury.publicKey.toBase58(),
      epoch: null,
      amount: 1n,
      requestId: randomUUID(),
      authorizationDigest: 'c'.repeat(64),
    })
  ).rejects.toThrow('recipient');
  const queued = await store.queueBudget({
    networkGenesis: fixtureGenesis,
    mint,
    kind: 'buyback',
    maximumLamports: 25_000_000n,
    minimumLamports: 25_000_000n,
  });
  expect(queued?.lamports).toBe('25000000');
});

it('keeps a pooled operating reserve before allowing treasury withdrawals', async () => {
  await collect(400_000_000n);
  const job = await store.queueBudget({
    networkGenesis: fixtureGenesis,
    mint,
    kind: 'platform_claim',
    maximumLamports: 1_000_000_000n,
  });
  expect(job?.lamports).toBe('9995000');
  expect(job?.recipient).toBe(treasury.publicKey.toBase58());
  expect((await balances()).platform).toBe(10_000_000n);
  const custody = await store.custodyRequirement(fixtureGenesis, collector.publicKey.toBase58());
  expect(custody.liability).toBe(380_000_000n + 9_995_000n);
});

it('waits for enough fee income to cover a collection and never uses buyback budgets as operating funding', async () => {
  await seedEvent(1000n);
  expect(await store.collectionAffordable(fixtureGenesis, mint, pool, 1000n, 5000n)).toBe(false);
  const queued = await store.queueCollection(
    fixtureGenesis,
    mint,
    await store.pendingFeeEvents(fixtureGenesis, mint)
  );
  await expect(sign(queued, 1000n)).rejects.toThrow('Accrue more');
});

it('funds a real-sized first collection without treating refunded WSOL rent as spent operating income', async () => {
  const net = 49444033n;
  await seedEvent(net);
  expect(await store.collectionAffordable(fixtureGenesis, mint, pool, net, 2049280n)).toBe(true);
  expect(await store.collectionAffordable(fixtureGenesis, mint, pool, net, 4088560n)).toBe(false);
  const queued = await store.queueCollection(
    fixtureGenesis,
    mint,
    await store.pendingFeeEvents(fixtureGenesis, mint)
  );
  const { job } = await sign(queued, net, {
    operatingCostLamports: '2049280',
    temporaryFundingLamports: '2039280',
  });
  await expect(store.assertOperatingFunding(job)).resolves.toBeUndefined();
  expect(
    (await store.custodyRequirement(fixtureGenesis, collector.publicKey.toBase58())).operating
  ).toBe(4088560n);
  await store.settle(
    job.id,
    effect(job, { receivedLamports: net, operatingCostLamports: 2044280n })
  );
  expect(await balances()).toMatchObject({ rinse_buyback: 46971831n, platform: 427922n });
  const buyback = await store.queueBudget({
    networkGenesis: fixtureGenesis,
    mint,
    kind: 'buyback',
    maximumLamports: 50000000n,
    minimumLamports: 25000000n,
  });
  expect(buyback?.lamports).toBe('46971831');
});

it('records a failed collection fee and recovers it from later operating income', async () => {
  await seedEvent(1_000_000n);
  const events = await store.pendingFeeEvents(fixtureGenesis, mint);
  const failed = await sign(await store.queueCollection(fixtureGenesis, mint, events), 1_000_000n);
  await expect(store.assertOperatingFunding(failed.job)).resolves.toBeUndefined();
  failed.fixture.response.meta!.err = { InstructionError: [0, 'Custom'] };
  const proof = await new FinalizedVerifier(failed.fixture.rpc, fixtureGenesis).failure(
    failed.fixture.signature,
    failed.job.message_digest!
  );
  await store.recordFailure(failed.job.id, proof);
  const retry = await sign(
    await store.queueCollection(
      fixtureGenesis,
      mint,
      await store.pendingFeeEvents(fixtureGenesis, mint)
    ),
    1_000_000n
  );
  await expect(store.assertOperatingFunding(retry.job)).resolves.toBeUndefined();
  await store.settle(retry.job.id, effect(retry.job, { receivedLamports: 1_000_000n }));
  expect((await balances()).platform).toBe(40_000n);
  expect((await balances()).rinse_buyback).toBe(950_000n);
});

it('can reapply startup migrations with Bond it. coins and rejects legacy modes under the new config', async () => {
  for (const file of migrations) await db.exec(migration(file));
  expect((await db.query('SELECT mode FROM launch_coins')).rows).toEqual([{ mode: 'bond' }]);
  await expect(
    db.query(
      `INSERT INTO pending_launch_intents(network_genesis,mint,config_key,deployer,mode,payload_digest,prepared_slot,expires_at)
    VALUES($1,$2,$3,$4,'creator',$5,900,now()+interval '1 hour')`,
      [
        fixtureGenesis,
        fixtureWallet().publicKey.toBase58(),
        config,
        creator.publicKey.toBase58(),
        'a'.repeat(64),
      ]
    )
  ).rejects.toThrow('economic policy');
});
