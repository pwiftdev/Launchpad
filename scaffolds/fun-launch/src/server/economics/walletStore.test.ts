import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { Pool, PoolClient } from 'pg';
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { SystemProgram, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { WalletStore } from './walletStore';
import {
  fixtureGenesis,
  fixtureWallet,
  transactionFixture,
  unsignedTransaction,
} from './financialFixtures';
import { messageDigest, FinalizedVerifier } from './chainEvidence';
import type { WalletJob, WalletEffectFacts } from './walletTypes';
import owner from '../../../../../docs/mainnet-authorities.public.json';
const proof = vi.hoisted(() => new WeakSet<object>());
vi.mock('./walletEvidence', () => ({
  assertVerifiedWalletEffect: (value: object) => {
    if (!proof.has(value)) throw new Error('Verified finalized effect required');
  },
}));
let db: PGlite, store: WalletStore;
const collector = fixtureWallet(),
  creator = fixtureWallet(),
  treasury = fixtureWallet(),
  mint = fixtureWallet().publicKey.toBase58(),
  pool = fixtureWallet().publicKey.toBase58(),
  config = fixtureWallet().publicKey.toBase58();
const migration = (name: string) =>
  readFileSync(new URL(`../../../../../scripts/migrations/${name}`, import.meta.url), 'utf8');
beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  let queue = Promise.resolve();
  const query = async (sql: string, args?: unknown[]) => {
    const r = await db.query(sql, args);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };
  store = new WalletStore({
    query,
    connect: async () => {
      const prior = queue;
      let release!: () => void;
      queue = new Promise<void>((r) => {
        release = r;
      });
      await prior;
      return { query, release } as unknown as PoolClient;
    },
  } as Pick<Pool, 'connect' | 'query'>);
}, 20000);
beforeEach(async () => {
  await db.exec('DROP SCHEMA public CASCADE;CREATE SCHEMA public;');
  await db.exec(migration('003-launch-registry.sql'));
  await db.exec(migration('017-wallet-settlement.sql'));
  await db.exec(migration('018-wallet-hourly-processing.sql'));
  await db.exec(migration('019-wallet-settlement-receipts.sql'));
  await db.query(
    `INSERT INTO launch_configs(network_genesis,config_key,policy_version,expected_fee_claimer,expected_leftover_receiver,config_digest,verified_slot)VALUES($1,$2,'wallet-v1',$3,$4,$5,1)`,
    [
      fixtureGenesis,
      config,
      collector.publicKey.toBase58(),
      treasury.publicKey.toBase58(),
      'a'.repeat(64),
    ]
  );
  await db.query(
    `INSERT INTO launch_coins(network_genesis,mint,dbc_pool,config_key,original_deployer,mode,recipient,policy_version,activation_point,creation_signature,finalized_slot)VALUES($1,$2,$3,$4,$5,'creator',$5,'wallet-v1',1000,'creation',1)`,
    [fixtureGenesis, mint, pool, config, creator.publicKey.toBase58()]
  );
});
afterAll(async () => db.close());
async function fund(bucket = 'creator', value = '100') {
  await db.query(
    'INSERT INTO wallet_balances(network_genesis,mint,bucket,funded)VALUES($1,$2,$3,$4)',
    [fixtureGenesis, mint, bucket, value]
  );
}
it('keeps old mainnet reward receipts readable while preventing the new collector from reserving old-wallet funds', async () => {
  const network = owner.networkGenesis,
    old = owner.legacyCompanyWallets[0]!;
  await db.query(
    `INSERT INTO launch_configs(network_genesis,config_key,policy_version,expected_fee_claimer,expected_leftover_receiver,config_digest,verified_slot)VALUES($1,$2,'wallet-v1',$3,$4,$5,1)`,
    [network, config, old.collector, old.treasury, 'b'.repeat(64)]
  );
  await db.query(
    `INSERT INTO launch_coins(network_genesis,mint,dbc_pool,config_key,original_deployer,mode,recipient,policy_version,activation_point,creation_signature,finalized_slot)VALUES($1,$2,$3,$4,$5,'creator',$5,'wallet-v1',1000,'historical-creation',1)`,
    [network, mint, pool, config, creator.publicKey.toBase58()]
  );
  await db.query(
    `INSERT INTO wallet_balances(network_genesis,mint,bucket,funded)VALUES($1,$2,'creator',100),($1,$2,'rinse_buyback',50000000)`,
    [network, mint]
  );
  vi.stubEnv('FEE_COLLECTOR_PUBLIC_KEY', owner.company.collector);
  vi.stubEnv('TREASURY_PUBLIC_KEY', owner.company.treasury);
  try {
    const view = await store.rewardsView({
      networkGenesis: network,
      mint,
      wallet: creator.publicKey.toBase58(),
    });
    expect(view.availableLamports).toBe('100');
    await expect(
      store.queueBudget({
        networkGenesis: network,
        mint,
        kind: 'buyback',
        maximumLamports: 50000000n,
      })
    ).rejects.toThrow('registry identity');
    expect(
      (
        await db.query<{ expected_fee_claimer: string }>(
          'SELECT expected_fee_claimer FROM launch_configs WHERE network_genesis=$1',
          [network]
        )
      ).rows[0]?.expected_fee_claimer
    ).toBe(old.collector);
    expect(
      (
        await db.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM wallet_jobs WHERE network_genesis=$1',
          [network]
        )
      ).rows[0]?.count
    ).toBe('0');
  } finally {
    vi.unstubAllEnvs();
  }
});
it('holds small buyback income without reserving it and admits the exact minimum', async () => {
  await fund('rinse_buyback', '24999999');
  const input = {
    networkGenesis: fixtureGenesis,
    mint,
    kind: 'buyback' as const,
    maximumLamports: 50_000_000n,
    minimumLamports: 25_000_000n,
  };
  expect(await store.queueBudget(input)).toBeNull();
  expect(
    (await store.balances(fixtureGenesis, mint)).find((b) => b.bucket === 'rinse_buyback')!.reserved
  ).toBe('0');
  await db.query(
    "UPDATE wallet_balances SET funded=25000000 WHERE mint=$1 AND bucket='rinse_buyback'",
    [mint]
  );
  expect((await store.queueBudget(input))!.lamports).toBe('25000000');
});
it('never queues another treasury withdrawal for an already attempted quarter hour', async () => {
  await fund('platform', '1000');
  const input = {
    networkGenesis: fixtureGenesis,
    mint,
    kind: 'platform_claim' as const,
    maximumLamports: 100n,
    intentKey: 'platform:quarter-hour:1',
  };
  const first = (await store.queueBudget(input))!;
  expect(first.recipient).toBe(treasury.publicKey.toBase58());
  expect((await store.queueBudget(input))!.id).toBe(first.id);
  await db.query("UPDATE wallet_jobs SET status='failed' WHERE id=$1", [first.id]);
  await db.query("UPDATE wallet_balances SET reserved=0 WHERE mint=$1 AND bucket='platform'", [
    mint,
  ]);
  expect(await store.queueBudget(input)).toBeNull();
  expect(
    (await store.queueBudget({ ...input, intentKey: 'platform:quarter-hour:2' }))!.id
  ).not.toBe(first.id);
});
const claim = (id = randomUUID(), value = 100n) =>
  store.requestClaim({
    networkGenesis: fixtureGenesis,
    mint,
    wallet: creator.publicKey.toBase58(),
    epoch: null,
    amount: value,
    requestId: id,
    authorizationDigest: 'b'.repeat(64),
  });
async function prepare(job: WalletJob) {
  const f = transactionFixture(
    [
      SystemProgram.transfer({
        fromPubkey: collector.publicKey,
        toPubkey: new PublicKey(job.recipient!),
        lamports: Number(job.lamports),
      }),
    ],
    collector
  );
  const prepared = await store.prepareJob(job.id, {
    networkGenesis: fixtureGenesis,
    mint: job.mint,
    kind: job.kind,
    transactionBase64: unsignedTransaction(f.tx),
    messageDigest: messageDigest(f.tx.serializeMessage()),
    preparedSlot: 900,
    lastValidBlockHeight: 1100,
    expectations: {
      collector: collector.publicKey.toBase58(),
      pool,
      recipient: job.recipient!,
      expectedLamports: job.lamports,
      maximumFeeLamports: '5000',
      operatingCostLamports: '5000',
    },
  });
  return {
    f,
    job: await store.attachSigned(
      prepared.id,
      Buffer.from(VersionedTransaction.deserialize(f.tx.serialize()).serialize()).toString('base64')
    ),
  };
}
function effect(job: WalletJob, extra: Partial<WalletEffectFacts> = {}): WalletEffectFacts {
  const value = {
    networkGenesis: fixtureGenesis,
    mint: job.mint,
    kind: job.kind,
    signature: job.signature!,
    slot: 1000,
    transactionIndex: 0,
    messageDigest: job.message_digest!,
    recipient: job.recipient!,
    paidLamports: job.kind.endsWith('_claim') ? BigInt(job.lamports) : undefined,
    collectorDebitLamports: job.kind.endsWith('_claim')
      ? job.recipient === collector.publicKey.toBase58()
        ? 0n
        : BigInt(job.lamports)
      : undefined,
    ...extra,
  } as WalletEffectFacts;
  proof.add(value);
  return value;
}
describe('wallet-v1 durable cash ledger', () => {
  it('reapplies without rewriting the immutable registered launch', async () => {
    await db.exec(migration('017-wallet-settlement.sql'));
    expect((await db.query('SELECT count(*)::text AS n FROM launch_coins')).rows[0]).toEqual({
      n: '1',
    });
    await expect(
      db.query("UPDATE launch_coins SET mode='community' WHERE mint=$1", [mint])
    ).rejects.toThrow();
  });
  it('concurrent duplicate and fresh authenticated requests reserve one payment only', async () => {
    await fund();
    const id = randomUUID();
    const [a, b] = await Promise.all([claim(id), claim(id)]);
    expect(a.id).toBe(b.id);
    const c = await claim();
    expect(c.id).toBe(a.id);
    expect((await store.balances(fixtureGenesis, mint))[0]).toMatchObject({
      funded: '100',
      reserved: '100',
      available: '0',
    });
    await expect(claim(id, 99n)).rejects.toThrow();
    expect(
      await store.payoutForRequest(fixtureGenesis, mint, treasury.publicKey.toBase58(), id)
    ).toBeNull();
  });
  it('rejects unbranded effects; lost response finalization pays exact entitlement once', async () => {
    await fund();
    const { job } = await prepare(await claim());
    await store.markSubmitted(job.id);
    await expect(store.settle(job.id, {} as WalletEffectFacts)).rejects.toThrow('Verified');
    const value = effect(job);
    await store.settle(job.id, value);
    await store.settle(job.id, value);
    expect((await store.balances(fixtureGenesis, mint))[0]).toMatchObject({
      funded: '100',
      reserved: '0',
      spent: '100',
    });
    await expect(claim()).rejects.toThrow();
    expect(
      (
        await store.rewardsView({
          networkGenesis: fixtureGenesis,
          mint,
          wallet: creator.publicKey.toBase58(),
        })
      ).paidLamports
    ).toBe('100');
  });
  it('rejects recipient/amount/policy drift without releasing a reserved payout', async () => {
    await fund();
    const job = await claim();
    const { job: signed } = await prepare(job);
    await expect(
      store.settle(job.id, effect(signed, { recipient: treasury.publicKey.toBase58() }))
    ).rejects.toThrow();
    expect((await store.balances(fixtureGenesis, mint))[0]!.reserved).toBe('100');
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
    ).rejects.toThrow();
  });
  it('keeps immutable public claim requests and signed attempts across restarts', async () => {
    await fund();
    const id = randomUUID(),
      { job } = await prepare(await claim(id));
    await store.markSubmitted(job.id);
    await store.markUncertain(job.id);
    expect(
      (await store.payoutForRequest(fixtureGenesis, mint, creator.publicKey.toBase58(), id))
        ?.signature
    ).toBe(job.signature);
    await expect(
      db.query('DELETE FROM wallet_claim_requests WHERE request_id=$1', [id])
    ).rejects.toThrow();
    await expect(
      db.query('UPDATE wallet_jobs SET lamports=99 WHERE id=$1', [job.id])
    ).rejects.toThrow();
  });
});

async function seedEvent(
  signature: string,
  phase: 0 | 1,
  net: string,
  poolAddress = pool,
  slot = 950
) {
  await db.query(
    `INSERT INTO wallet_fee_events(network_genesis,mint,pool,signature,instruction_index,event_index,finalized_slot,trade_time,phase,total,protocol,referral,net,event_digest)VALUES($1,$2,$3,$4,0,1,$5,1100,$6,$7,0,0,$7,$8)`,
    [fixtureGenesis, mint, poolAddress, signature, slot, phase, net, 'd'.repeat(64)]
  );
}
async function signGeneric(job: WalletJob, extra: Record<string, unknown> = {}) {
  const f = transactionFixture(
    [
      SystemProgram.transfer({
        fromPubkey: collector.publicKey,
        toPubkey: treasury.publicKey,
        lamports: 1,
      }),
    ],
    collector
  );
  const prepared = await store.prepareJob(job.id, {
    networkGenesis: fixtureGenesis,
    mint,
    kind: job.kind,
    transactionBase64: unsignedTransaction(f.tx),
    messageDigest: messageDigest(f.tx.serializeMessage()),
    preparedSlot: 900,
    lastValidBlockHeight: 1100,
    expectations: {
      collector: collector.publicKey.toBase58(),
      pool: String(job.details.pool ?? pool),
      maximumFeeLamports: '5000',
      operatingCostLamports: '5000',
      ...extra,
    },
  });
  return store.attachSigned(
    prepared.id,
    Buffer.from(VersionedTransaction.deserialize(f.tx.serialize()).serialize()).toString('base64')
  );
}
describe('actual collected income only', () => {
  it('allocates mixed RINSE/post DBC receipts exactly, including cumulative integer carry and idempotent receipt retry', async () => {
    await seedEvent('rinse', 0, '7');
    await seedEvent('post', 1, '7');
    const queued = await store.queueCollection(
        fixtureGenesis,
        mint,
        await store.pendingFeeEvents(fixtureGenesis, mint)
      ),
      job = await signGeneric(queued);
    const value = effect(job, { receivedLamports: 14n });
    await store.settle(job.id, value);
    await store.settle(job.id, value);
    const balances = await store.balances(fixtureGenesis, mint);
    expect(balances.reduce((n, r) => n + BigInt(r.funded), 0n)).toBe(14n);
    expect(balances.find((r) => r.bucket === 'rinse_buyback')!.funded).toBe('5');
    expect(balances.find((r) => r.bucket === 'creator')!.funded).toBe('3');
    expect(await store.pendingFeeEvents(fixtureGenesis, mint)).toEqual([]);
    await seedEvent('rinse2', 0, '3');
    const next = await signGeneric(
      await store.queueCollection(
        fixtureGenesis,
        mint,
        await store.pendingFeeEvents(fixtureGenesis, mint)
      )
    );
    await store.settle(next.id, effect(next, { receivedLamports: 3n }));
    expect(
      (await store.balances(fixtureGenesis, mint)).find((r) => r.bucket === 'rinse_buyback')!.funded
    ).toBe('8');
    await expect(db.query('UPDATE wallet_collections SET received=100')).rejects.toThrow();
  });
  it('does not fund on raw events, mismatched receipts or operating rent/fees', async () => {
    await seedEvent('raw', 0, '10');
    expect(await store.balances(fixtureGenesis, mint)).toEqual([]);
    const job = await signGeneric(
      await store.queueCollection(
        fixtureGenesis,
        mint,
        await store.pendingFeeEvents(fixtureGenesis, mint)
      )
    );
    await expect(store.settle(job.id, effect(job, { receivedLamports: 11n }))).rejects.toThrow();
    expect(await store.balances(fixtureGenesis, mint)).toEqual([]);
    expect((await store.job(job.id))!.status).toBe('signed');
  });
  it('DAMM credits actual owned income below raw and preserves later same-slot trades for another claim', async () => {
    const damm = fixtureWallet().publicKey.toBase58();
    await seedEvent('earlier', 1, '100', damm, 999);
    await seedEvent('later', 1, '200', damm, 1000);
    const events = await store.pendingFeeEvents(fixtureGenesis, mint),
      job = await signGeneric(
        await store.queueCollection(
          fixtureGenesis,
          mint,
          events.filter((r) => r.id.signature === 'earlier')
        )
      );
    await store.indexCursor(fixtureGenesis, damm);
    await store.advanceIndexCursor({
      ...(await store.indexCursor(fixtureGenesis, damm)),
      complete: true,
      finalized_slot: '1000',
    });
    const value = effect(job, {
      receivedLamports: 99n,
      transactionIndex: 1,
      slotSignatures: ['earlier', job.signature!, 'later'],
    });
    await store.settle(job.id, value);
    expect(
      (await store.balances(fixtureGenesis, mint)).reduce((s, r) => s + BigInt(r.funded), 0n)
    ).toBe(99n);
    expect((await store.pendingFeeEvents(fixtureGenesis, mint)).map((r) => r.id.signature)).toEqual(
      ['later']
    );
    expect(
      (await db.query('SELECT raw_observed::text,received::text FROM wallet_collections')).rows[0]
    ).toEqual({ raw_observed: '100', received: '99' });
  });
  it('DAMM refuses a partial index or absent canonical block ordering without consuming observations', async () => {
    const damm = fixtureWallet().publicKey.toBase58();
    await seedEvent('earlier', 1, '100', damm);
    const job = await signGeneric(
      await store.queueCollection(
        fixtureGenesis,
        mint,
        await store.pendingFeeEvents(fixtureGenesis, mint)
      )
    );
    await expect(
      store.settle(job.id, effect(job, { receivedLamports: 90n, slotSignatures: [job.signature!] }))
    ).rejects.toThrow('Index');
    expect(
      (await db.query('SELECT count(*)::text AS n FROM wallet_collection_cursors')).rows[0]
    ).toEqual({ n: '0' });
  });
  it('atomic buyback settles only actual spend and releases unused maximum reservation', async () => {
    await fund('rinse_buyback', '100');
    const queued = await store.queueBudget({
      networkGenesis: fixtureGenesis,
      mint,
      kind: 'buyback',
      maximumLamports: 100n,
    });
    const job = await signGeneric(queued!, { maximumSpendLamports: '100' });
    await store.settle(job.id, effect(job, { collectorDebitLamports: 80n, burnedTokens: 700n }));
    expect((await store.balances(fixtureGenesis, mint))[0]).toMatchObject({
      funded: '100',
      reserved: '0',
      spent: '80',
      available: '20',
    });
    expect((await store.job(job.id))!.burned_tokens).toBe('700');
  });
});
import { snapshotFixture } from './holderSnapshotFixture';
import { collectHolderSnapshot } from './holderSnapshot';
it('Community snapshots allocate funded same-bank income once, carry dust and keep later receipts out', async () => {
  const f = snapshotFixture(),
    cm = f.mint.toBase58(),
    cp = fixtureWallet().publicKey.toBase58();
  await db.query(
    `INSERT INTO launch_coins(network_genesis,mint,dbc_pool,config_key,original_deployer,mode,recipient,policy_version,activation_point,creation_signature,finalized_slot)VALUES($1,$2,$3,$4,$5,'community',$6,'wallet-v1',1000,'communitycreation',1)`,
    [fixtureGenesis, cm, cp, config, creator.publicKey.toBase58(), collector.publicKey.toBase58()]
  );
  f.rpc.getBlockTime = async () => 7350;
  const snapshot = await collectHolderSnapshot(f.rpc, {
    networkGenesis: fixtureGenesis,
    mint: cm,
    excludedOwners: new Set(),
  });
  await expect(
    store.createEpoch({ networkGenesis: fixtureGenesis, mint: cm, epoch: 1, snapshot })
  ).rejects.toThrow('No collected income');
  expect(await store.epoch(fixtureGenesis, cm, 1)).toBeNull();
  for (const [slot, value] of [
    [999, 11],
    [1500, 20],
  ]) {
    const id = randomUUID();
    await db.query(
      `INSERT INTO wallet_jobs(id,network_genesis,mint,kind,intent_key,status,transaction_base64,message_digest,prepared_slot,last_valid_block_height,signature,finalized_slot,received_lamports)VALUES($1::uuid,$2,$3,'collect',$1::text,'finalized','fixture',repeat('a',64),900,1100,$1::text,$4,$5)`,
      [id, fixtureGenesis, cm, slot, value]
    );
    await db.query(
      `INSERT INTO wallet_collections(job_id,network_genesis,mint,pool,signature,finalized_slot,transaction_index,received,raw_observed,rinse_net,post_net,rinse_buyback,creator,community,platform)VALUES($1::uuid,$2,$3,$4,$1::text,$5,0,$6,$6,0,$6,0,0,$6,0)`,
      [id, fixtureGenesis, cm, cp, slot, value]
    );
  }
  await db.query(
    `INSERT INTO wallet_balances(network_genesis,mint,bucket,funded)VALUES($1,$2,'community',31)`,
    [fixtureGenesis, cm]
  );
  const epoch = await store.createEpoch({
    networkGenesis: fixtureGenesis,
    mint: cm,
    epoch: 1,
    snapshot,
  });
  expect(epoch).toMatchObject({ budget: '11', allocated: '10', carry: '1' });
  expect(Number(epoch.snapshot_time)).toBe(7350);
  await store.createEpoch({ networkGenesis: fixtureGenesis, mint: cm, epoch: 1, snapshot });
  expect((await store.balances(fixtureGenesis, cm))[0]).toMatchObject({
    funded: '31',
    reserved: '10',
    available: '21',
  });
  const wallet = f.owners[0]!.publicKey.toBase58(),
    id = randomUUID(),
    input = {
      networkGenesis: fixtureGenesis,
      mint: cm,
      wallet,
      epoch: 1,
      amount: 8n,
      requestId: id,
      authorizationDigest: 'b'.repeat(64),
    };
  const [a, b] = await Promise.all([store.requestClaim(input), store.requestClaim(input)]);
  expect(a.id).toBe(b.id);
  expect((await store.balances(fixtureGenesis, cm))[0]!.reserved).toBe('10');
  expect(
    (await store.rewardsView({ networkGenesis: fixtureGenesis, mint: cm, wallet })).epochs[0]
  ).toMatchObject({ epoch: '1', lamports: '8', status: 'queued' });
  await expect(
    store.requestClaim({ ...input, requestId: randomUUID(), amount: 7n })
  ).rejects.toThrow('Exact');
  await expect(
    store.createEpoch({ networkGenesis: fixtureGenesis, mint: cm, epoch: 0, snapshot })
  ).rejects.toThrow('current processing hour');
});
import { verifyWalletRecovery } from './walletRecovery';
import type { Connection } from '@solana/web3.js';
it('signed expired payout renewal archives exact bytes, retains reservation, and cannot renew twice', async () => {
  await fund();
  const requestId = randomUUID(),
    { job } = await prepare(await claim(requestId));
  await store.markSubmitted(job.id);
  const hashes = Array.from({ length: 203 }, () => fixtureWallet().publicKey.toBase58());
  const block = (slot: number) => ({
    blockHeight: slot,
    blockhash: hashes[slot - 900]!,
    parentSlot: slot - 1,
    previousBlockhash: hashes[slot - 901] ?? fixtureWallet().publicKey.toBase58(),
  });
  const blocks = new Map(Array.from({ length: 203 }, (_, i) => [900 + i, block(900 + i)]));
  const rpc = {
    getGenesisHash: async () => fixtureGenesis,
    getEpochInfo: async () => ({ absoluteSlot: 1200, blockHeight: 1200 }),
    isBlockhashValid: async () => ({ context: { slot: 1200 }, value: false }),
    getSignatureStatuses: async () => ({ context: { slot: 1200 }, value: [null as null] }),
    getTransaction: async (): Promise<null> => null,
    getFirstAvailableBlock: async () => 899,
    getBlocks: async () => [...blocks.keys()],
    getBlock: async (slot: number) => blocks.get(slot),
    getBlockSignatures: async (slot: number) => ({
      ...blocks.get(slot),
      signatures: [] as string[],
    }),
  } as unknown as Connection;
  const proof = await verifyWalletRecovery(rpc, job),
    results = await Promise.allSettled([store.renew(job.id, proof), store.renew(job.id, proof)]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect((await store.balances(fixtureGenesis, mint))[0]).toMatchObject({
    reserved: '100',
    spent: '0',
  });
  expect(
    await store.payoutForRequest(fixtureGenesis, mint, creator.publicKey.toBase58(), requestId)
  ).toMatchObject({ id: job.id, status: 'queued', signature: null, transaction_base64: null });
  const attempts = (
    await db.query<{ signature: string; transaction_base64: string }>(
      'SELECT signature,transaction_base64 FROM wallet_job_attempts'
    )
  ).rows;
  expect(attempts).toEqual([
    { signature: job.signature, transaction_base64: job.transaction_base64 },
  ]);
  const renewed = await prepare((await store.job(job.id))!);
  expect(renewed.job.id).toBe(job.id);
  expect(renewed.job.signature).not.toBe(job.signature);
  await expect(store.renew(job.id, proof)).rejects.toThrow();
});
it('new signatures wait for earlier unsettled collector receipts; finalized history does not block', async () => {
  await fund();
  const { job } = await prepare(await claim());
  await expect(
    store.assertNoUnsettledSigned(fixtureGenesis, collector.publicKey.toBase58(), randomUUID())
  ).rejects.toThrow('Reconcile');
  await expect(
    store.assertNoUnsettledSigned(fixtureGenesis, collector.publicKey.toBase58(), job.id)
  ).resolves.toBeUndefined();
  await store.settle(job.id, effect(job));
  await expect(
    store.assertNoUnsettledSigned(fixtureGenesis, collector.publicKey.toBase58(), randomUUID())
  ).resolves.toBeUndefined();
});
it('status exposes missing baseline cursors instead of hiding them behind an empty event table', async () => {
  const health = await store.health(fixtureGenesis, collector.publicKey.toBase58());
  expect(health).toMatchObject({ totalPools: 1, missingOrPartialCursors: 1 });
  await store.indexCursor(fixtureGenesis, pool);
  await store.advanceIndexCursor({
    ...(await store.indexCursor(fixtureGenesis, pool)),
    complete: true,
    finalized_slot: '1000',
  });
  expect(
    (await store.health(fixtureGenesis, collector.publicKey.toBase58())).missingOrPartialCursors
  ).toBe(0);
  await store.advanceIndexCursor({
    ...(await store.indexCursor(fixtureGenesis, pool)),
    scan_head_signature: 'pending-scan',
  });
  expect(
    (await store.health(fixtureGenesis, collector.publicKey.toBase58())).missingOrPartialCursors
  ).toBe(1);
});
it('company payout destination is immutable and only exact finalized income can be spent', async () => {
  await fund('platform', '200');
  const queued = (await store.queueBudget({
    networkGenesis: fixtureGenesis,
    mint,
    kind: 'platform_claim',
    maximumLamports: 50n,
  }))!;
  expect(queued.recipient).toBe(treasury.publicKey.toBase58());
  const { job } = await prepare(queued);
  await expect(
    store.settle(job.id, effect(job, { recipient: creator.publicKey.toBase58() }))
  ).rejects.toThrow();
  await store.settle(job.id, effect(job));
  expect((await store.balances(fixtureGenesis, mint))[0]).toMatchObject({
    funded: '200',
    reserved: '0',
    spent: '50',
    available: '150',
  });
});
it('independently finalized failure releases creator reservation once and preserves old request evidence', async () => {
  await fund();
  const id = randomUUID(),
    { job, f } = await prepare(await claim(id));
  f.response.meta!.err = { InstructionError: [0, { Custom: 1 }] };
  const failed = await new FinalizedVerifier(f.rpc, fixtureGenesis).failure(
    job.signature!,
    job.message_digest!
  );
  await store.recordFailure(job.id, failed);
  await store.recordFailure(job.id, failed);
  expect((await store.balances(fixtureGenesis, mint))[0]).toMatchObject({
    reserved: '0',
    spent: '0',
    available: '100',
  });
  expect(
    (await store.payoutForRequest(fixtureGenesis, mint, creator.publicKey.toBase58(), id))!.status
  ).toBe('failed');
  const next = await claim();
  expect(next.id).not.toBe(job.id);
  expect((await store.balances(fixtureGenesis, mint))[0]!.reserved).toBe('100');
});
it('durable finalized burn facts store actual spend and reject conflicting replay without another debit', async () => {
  await fund('rinse_buyback', '100');
  const queued = (await store.queueBudget({
      networkGenesis: fixtureGenesis,
      mint,
      kind: 'buyback',
      maximumLamports: 100n,
    }))!,
    job = await signGeneric(queued, { maximumSpendLamports: '100' }),
    receipt = effect(job, { collectorDebitLamports: 80n, burnedTokens: 700n });
  await store.settle(job.id, receipt);
  expect(
    (
      await db.query(
        'SELECT actual_spent_lamports::text,burned_tokens::text FROM wallet_settlements WHERE job_id=$1',
        [job.id]
      )
    ).rows[0]
  ).toEqual({ actual_spent_lamports: '80', burned_tokens: '700' });
  await expect(
    store.settle(job.id, effect(job, { collectorDebitLamports: 79n, burnedTokens: 700n }))
  ).rejects.toThrow('different immutable');
  expect((await store.balances(fixtureGenesis, mint))[0]!.spent).toBe('80');
  await expect(
    db.query('DELETE FROM wallet_settlements WHERE job_id=$1', [job.id])
  ).rejects.toThrow('append-only');
});
it('fresh verified evidence can backfill an older finalized job fact without touching balances', async () => {
  await fund('rinse_buyback', '100');
  const queued = (await store.queueBudget({
      networkGenesis: fixtureGenesis,
      mint,
      kind: 'buyback',
      maximumLamports: 100n,
    }))!,
    job = await signGeneric(queued, { maximumSpendLamports: '100' });
  await db.query(
    `UPDATE wallet_jobs SET status='finalized',finalized_slot=1000,burned_tokens=700 WHERE id=$1`,
    [job.id]
  );
  await db.query(
    `UPDATE wallet_balances SET reserved=0,spent=80 WHERE network_genesis=$1 AND mint=$2 AND bucket='rinse_buyback'`,
    [fixtureGenesis, mint]
  );
  const before = await store.balances(fixtureGenesis, mint);
  await store.settle(job.id, effect(job, { collectorDebitLamports: 80n, burnedTokens: 700n }));
  await store.settle(job.id, effect(job, { collectorDebitLamports: 80n, burnedTokens: 700n }));
  expect(await store.balances(fixtureGenesis, mint)).toEqual(before);
  expect(
    (await db.query('SELECT count(*)::text AS n FROM wallet_settlements WHERE job_id=$1', [job.id]))
      .rows[0]
  ).toEqual({ n: '1' });
});
