import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { Pool, PoolClient } from 'pg';
import { HSOL_REWARD_MINT, SOL_REWARD_MINT } from '@/lib/rewards';
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
const companyFixture = vi.hoisted(() => ({ collector: '', treasury: '' }));
vi.mock('../../../../../scripts/company-wallets.cjs', async (load) => {
  const real = await load<typeof import('../../../../../scripts/company-wallets.cjs')>();
  return {
    ...real,
    companyWallets: (...args: Parameters<typeof real.companyWallets>) => {
      const [env, genesis] = args;
      if (
        companyFixture.collector &&
        env.FEE_COLLECTOR_PUBLIC_KEY === companyFixture.collector &&
        env.TREASURY_PUBLIC_KEY === companyFixture.treasury &&
        ['cashback-hsol-v1', 'mskd-hsol-v1'].includes(env.LAUNCH_POLICY_VERSION ?? '')
      )
        return real.companyWallets(env, fixtureGenesis);
      return real.companyWallets(env, genesis, args[2]);
    },
  };
});
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
  companyFixture.collector = companyFixture.treasury = '';
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

it('keeps hSOL liabilities out of the SOL ledger and reserves an exact creator claim once', async () => {
  for (const file of [
    '024-bond-it-policy.sql',
    '025-mskd-modes.sql',
    '026-mskd-sol-pair.sql',
    '027-holder-payout-allocations.sql',
    '033-hsol-launch-pair.sql',
  ]) {
    await db.exec(migration(file));
  }
  const network = owner.networkGenesis;
  const collectorKey = collector.publicKey.toBase58();
  const creatorKey = creator.publicKey.toBase58();
  const hsolConfig = fixtureWallet().publicKey.toBase58();
  const hsolMint = fixtureWallet().publicKey.toBase58();
  const hsolPool = fixtureWallet().publicKey.toBase58();
  for (const [key, policy, quote] of [
    [config, 'dev-v1', SOL_REWARD_MINT],
    [hsolConfig, 'hsol-v1', HSOL_REWARD_MINT],
  ]) {
    await db.query(
      'INSERT INTO launch_configs(network_genesis,config_key,policy_version,expected_fee_claimer,expected_leftover_receiver,config_digest,verified_slot,quote_mint) VALUES($1,$2,$3,$4,$5,$6,1,$7)',
      [network, key, policy, collectorKey, treasury.publicKey.toBase58(), 'a'.repeat(64), quote]
    );
  }
  for (const [token, tokenPool, key, mode, quote] of [
    [mint, pool, config, 'dev', SOL_REWARD_MINT],
    [hsolMint, hsolPool, hsolConfig, 'hsol', HSOL_REWARD_MINT],
  ]) {
    await db.query(
      'INSERT INTO launch_coins(network_genesis,mint,dbc_pool,config_key,original_deployer,mode,recipient,policy_version,activation_point,activation_time,creation_signature,finalized_slot,quote_mint) VALUES($1,$2,$3,$4,$5,$6,$5,$7,1000,1000,$8,1,$9)',
      [network, token, tokenPool, key, creatorKey, mode, mode + '-v1', mode + '-creation', quote]
    );
  }
  await db.query(
    "INSERT INTO wallet_balances(network_genesis,mint,bucket,funded) VALUES($1,$2,'creator',11),($1,$3,'creator',100),($1,$3,'platform',40)",
    [network, mint, hsolMint]
  );
  expect((await store.custodyRequirement(network, collectorKey)).liability).toBe(11n);
  expect(
    (await store.tokenCustodyRequirement(network, collectorKey, HSOL_REWARD_MINT)).liability
  ).toBe(140n);
  const request = {
    networkGenesis: network,
    mint: hsolMint,
    wallet: creatorKey,
    epoch: null as null,
    amount: 100n,
    requestId: randomUUID(),
    authorizationDigest: 'b'.repeat(64),
  };
  await expect(store.requestClaim({ ...request, assetMint: SOL_REWARD_MINT })).rejects.toThrow(
    'asset'
  );
  const claim = await store.requestClaim({ ...request, assetMint: HSOL_REWARD_MINT });
  expect(claim).toMatchObject({
    kind: 'creator_claim',
    lamports: '100',
    details: { assetMint: HSOL_REWARD_MINT },
  });
  expect((await store.requestClaim({ ...request, assetMint: HSOL_REWARD_MINT })).id).toBe(claim.id);
  expect((await store.balances(network, hsolMint))[0]).toMatchObject({
    reserved: '100',
    spent: '0',
  });
});
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
it('queues the full claim ahead of earlier treasury work and serializes durable signatures', async () => {
  await fund('creator', '1444866467');
  await fund('platform', '1000');
  const treasuryJob = (await store.queueBudget({
    networkGenesis: fixtureGenesis,
    mint,
    kind: 'platform_claim',
    maximumLamports: 100n,
    intentKey: 'platform:quarter-hour:priority',
  }))!;
  const userJob = await claim(randomUUID(), 1444866467n);
  const collectorAddress = collector.publicKey.toBase58();
  const candidates = () => store.executionCandidates(fixtureGenesis, collectorAddress, 20);
  const treasuryAttempt = await prepare(treasuryJob, {}, false);
  expect(await candidates()).toEqual([{ id: userJob.id }, { id: treasuryJob.id }]);
  const userAttempt = await prepare(userJob, {}, false);
  const savedTreasury = await store.attachSigned(treasuryJob.id, treasuryAttempt.wire);
  expect(await candidates()).toEqual([{ id: savedTreasury.id }, { id: userJob.id }]);
  await expect(store.attachSigned(userJob.id, userAttempt.wire)).rejects.toThrow(
    'Reconcile the existing signed collector attempt'
  );
  expect((await store.job(userJob.id))?.signature).toBeNull();
  await store.settle(savedTreasury.id, effect(savedTreasury));
  expect(await candidates()).toEqual([{ id: userJob.id }]);
  expect((await store.attachSigned(userJob.id, userAttempt.wire)).lamports).toBe('1444866467');
});
async function prepare(job: WalletJob, extra: Record<string, unknown> = {}, attach = true) {
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
    networkGenesis: job.network_genesis,
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
      ...extra,
    },
  });
  const wire = Buffer.from(VersionedTransaction.deserialize(f.tx.serialize()).serialize()).toString(
    'base64'
  );
  return { f, wire, job: attach ? await store.attachSigned(prepared.id, wire) : prepared };
}
function effect(job: WalletJob, extra: Partial<WalletEffectFacts> = {}): WalletEffectFacts {
  const value = {
    networkGenesis: job.network_genesis,
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
    networkGenesis: job.network_genesis,
    mint: job.mint,
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
async function fundHolderCollection(
  mint: string,
  pool: string,
  slot: number,
  value: number,
  network = fixtureGenesis
) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO wallet_jobs(id,network_genesis,mint,kind,intent_key,status,transaction_base64,message_digest,prepared_slot,last_valid_block_height,signature,finalized_slot,received_lamports)VALUES($1::uuid,$2,$3,'collect',$1::text,'finalized','fixture',repeat('a',64),900,1100,$1::text,$4,$5)`,
    [id, network, mint, slot, value]
  );
  await db.query(
    `INSERT INTO wallet_collections(job_id,network_genesis,mint,pool,signature,finalized_slot,transaction_index,received,raw_observed,rinse_net,post_net,rinse_buyback,creator,community,platform)VALUES($1::uuid,$2,$3,$4,$1::text,$5,0,$6,$6,0,$6,0,0,$6,0)`,
    [id, network, mint, pool, slot, value]
  );
}
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
    await fundHolderCollection(cm, cp, slot!, value!);
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

async function registerHolderFixture(
  fixture: ReturnType<typeof snapshotFixture>,
  mode: 'cashback' | 'cashback-hsol' | 'mskd' | 'mskd-hsol'
) {
  for (const name of [
    '024-bond-it-policy.sql',
    '025-mskd-modes.sql',
    '026-mskd-sol-pair.sql',
    '027-holder-payout-allocations.sql',
    '028-mskd-payout-conversions.sql',
    '033-hsol-launch-pair.sql',
    '034-hsol-holder-modes.sql',
  ])
    await db.exec(migration(name));
  const hsol = mode.endsWith('-hsol');
  const network = hsol ? owner.networkGenesis : fixtureGenesis;
  const quoteMint = hsol ? HSOL_REWARD_MINT : SOL_REWARD_MINT;
  fixture.rpc.getGenesisHash = async () => network;
  const mint = fixture.mint.toBase58();
  const pool = fixtureWallet().publicKey.toBase58();
  const config = fixtureWallet().publicKey.toBase58();
  const company = [collector.publicKey.toBase58(), treasury.publicKey.toBase58()];
  if (hsol) {
    companyFixture.collector = company[0]!;
    companyFixture.treasury = company[1]!;
  }
  await db.query(
    `INSERT INTO launch_configs(network_genesis,config_key,policy_version,expected_fee_claimer,expected_leftover_receiver,config_digest,verified_slot,quote_mint)VALUES($1,$2,$3,$4,$5,repeat('a',64),1,$6)`,
    [network, config, `${mode}-v1`, ...company, quoteMint]
  );
  await db.query(
    `INSERT INTO launch_coins(network_genesis,mint,dbc_pool,config_key,original_deployer,mode,recipient,policy_version,activation_point,activation_time,creation_signature,finalized_slot,quote_mint)VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,1,'holder-creation',1,$9)`,
    [
      network,
      mint,
      pool,
      config,
      creator.publicKey.toBase58(),
      mode,
      company[0],
      `${mode}-v1`,
      quoteMint,
    ]
  );
  return { mint, pool, company, network, quoteMint, hsol };
}

it.each(['cashback', 'cashback-hsol'] as const)(
  'batches %s once through ambiguous relay and failed finalization writes',
  async (mode) => {
    const fixture = snapshotFixture();
    const { mint, pool, company, network, quoteMint } = await registerHolderFixture(fixture, mode);
    await db.query(
      `INSERT INTO wallet_balances(network_genesis,mint,bucket,funded)VALUES($1,$2,'community',1600000)`,
      [network, mint]
    );
    const advance = async (epoch: number, deadlineOffset: number, excluded = company) => {
      fixture.rpc.getBlockTime = async () => (epoch + 1) * 3600 + deadlineOffset;
      const snapshot = await collectHolderSnapshot(fixture.rpc, {
        networkGenesis: network,
        mint,
        excludedOwners: new Set(excluded),
      });
      return store.createEpoch({ networkGenesis: network, mint, epoch, snapshot });
    };
    const holder = {
      networkGenesis: network,
      mint,
      wallet: fixture.owners[0]!.publicKey.toBase58(),
    };
    const view = () => store.rewardsView({ ...holder, limit: 1 });
    await fundHolderCollection(mint, pool, 999, 800_000, network);
    await expect(advance(1, 60)).rejects.toThrow('hourly snapshot');
    await expect(advance(1, 5, [])).rejects.toThrow('company wallet exclusions');
    const first = await advance(1, 5);
    expect(await advance(1, 5)).toEqual(first);
    expect(await view()).toMatchObject({ availableLamports: '600000', holderClaim: null });
    await fundHolderCollection(mint, pool, 1000, 800_000, network);
    await advance(2, 5);
    expect(await view()).toMatchObject({
      availableLamports: '1200000',
      holderClaim: { amount: '1200000', throughEpoch: '2', assetMint: quoteMint },
    });
    const claim = {
      ...holder,
      epoch: 2,
      amount: 1_200_000n,
      assetMint: quoteMint,
      authorizationDigest: 'a'.repeat(64),
      requestId: randomUUID(),
    };
    await expect(store.requestClaim({ ...claim, amount: 1_200_001n })).rejects.toThrow(
      'exact funded'
    );
    const [queued, replay] = await Promise.all([
      store.requestClaim(claim),
      store.requestClaim(claim),
    ]);
    expect(replay.id).toBe(queued.id);
    const failed = await prepare(queued, { quoteMint });
    failed.f.rpc.getGenesisHash = async () => network;
    await store.markSubmitted(failed.job.id);
    await store.markUncertain(failed.job.id);
    expect((await view()).availableLamports).toBe('0');
    failed.f.response.meta!.err = { InstructionError: [0, { Custom: 1 }] };
    const failure = await new FinalizedVerifier(failed.f.rpc, network).failure(
      failed.job.signature!,
      failed.job.message_digest!
    );
    await store.recordFailure(failed.job.id, failure);
    expect((await view()).availableLamports).toBe('1200000');
    const { job } = await prepare(await store.requestClaim({ ...claim, requestId: randomUUID() }), {
      quoteMint,
    });
    await store.markSubmitted(job.id);
    const receipt = effect(job, { operatingCostLamports: 5000n });
    await db.exec(
      'ALTER TABLE wallet_settlements ADD CONSTRAINT force_fixture_rollback CHECK(false)'
    );
    await expect(store.settle(job.id, receipt)).rejects.toThrow('force_fixture_rollback');
    expect(await store.job(job.id)).toMatchObject({
      status: 'submitted',
      signature: job.signature,
    });
    expect((await view()).availableLamports).toBe('0');
    await db.exec('ALTER TABLE wallet_settlements DROP CONSTRAINT force_fixture_rollback');
    await store.settle(job.id, receipt);
    await store.settle(job.id, receipt);
    const final = await store.rewardsView(holder);
    expect(final.paidLamports).toBe('1200000');
    expect(final.epochs).toHaveLength(2);
    expect(
      final.epochs.every((entry) => entry.status === 'paid' && entry.signature === job.signature)
    ).toBe(true);
    await expect(store.requestClaim({ ...claim, requestId: randomUUID() })).rejects.toThrow();
  }
);

it.each(['mskd', 'mskd-hsol'] as const)(
  'reserves %s once, preserves interrupted receipts and pays only actual converted wXMR',
  async (mode) => {
    const fixture = snapshotFixture();
    const { mint, pool, company, network, quoteMint, hsol } = await registerHolderFixture(
      fixture,
      mode
    );
    const assetMint = hsol
      ? 'WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp'
      : fixtureWallet().publicKey.toBase58();
    const market = fixtureWallet().publicKey.toBase58();
    vi.stubEnv('MSKD_DEVNET_PAYOUT_MINT', assetMint);
    vi.stubEnv('MSKD_PAYOUT_POOL', market);
    try {
      await db.query(
        `INSERT INTO wallet_balances(network_genesis,mint,bucket,funded)VALUES($1,$2,'community',2000000)`,
        [network, mint]
      );
      await fundHolderCollection(mint, pool, 999, 2_000_000, network);
      fixture.rpc.getBlockTime = async () => 7205;
      const snapshot = await collectHolderSnapshot(fixture.rpc, {
        networkGenesis: network,
        mint,
        excludedOwners: new Set(company),
      });
      await db.exec(
        'ALTER TABLE wallet_mskd_snapshots ADD CONSTRAINT force_queue_rollback CHECK(false)'
      );
      await expect(store.queueMskdConversion(snapshot)).rejects.toThrow('force_queue_rollback');
      expect(await store.pendingJobs(network, mint)).toEqual([]);
      expect((await store.balances(network, mint))[0]!.reserved).toBe('0');
      await db.exec('ALTER TABLE wallet_mskd_snapshots DROP CONSTRAINT force_queue_rollback');
      const [first, replay] = await Promise.all([
        store.queueMskdConversion(snapshot),
        store.queueMskdConversion(snapshot),
      ]);
      expect(first).toMatchObject({ kind: 'holder_conversion', lamports: '2000000' });
      expect(replay).toBeNull();
      const view = () =>
        store.rewardsView({
          networkGenesis: network,
          mint,
          wallet: fixture.owners[0]!.publicKey.toBase58(),
        });
      expect((await view()).availableLamports).toBe('0');
      expect((await store.custodyRequirement(network, company[0]!)).liability).toBe(
        hsol ? 0n : 2_000_000n
      );
      if (hsol)
        expect(
          (await store.tokenCustodyRequirement(network, company[0]!, quoteMint)).liability
        ).toBe(2_000_000n);
      const job = await signGeneric(first!, {
        quoteMint,
        maximumSpendLamports: '2000000',
        pool: market,
        payoutMint: assetMint,
      });
      await store.markSubmitted(job.id);
      await store.markUncertain(job.id);
      const converted = effect(job, {
        collectorDebitLamports: hsol ? 1_995_000n : 2_000_000n,
        receivedPayoutUnits: 101n,
        operatingCostLamports: 5000n,
      });
      await db.exec(
        'ALTER TABLE wallet_mskd_conversions ADD CONSTRAINT force_fixture_rollback CHECK(false)'
      );
      await expect(store.settle(job.id, converted)).rejects.toThrow('force_fixture_rollback');
      expect(await store.job(job.id)).toMatchObject({
        status: 'manual_review',
        signature: job.signature,
      });
      expect((await view()).availableLamports).toBe('0');
      expect(await store.queueMskdConversion(snapshot)).toBeNull();
      await db.exec('ALTER TABLE wallet_mskd_conversions DROP CONSTRAINT force_fixture_rollback');
      await store.settle(job.id, converted);
      await store.settle(job.id, converted);
      expect((await store.custodyRequirement(network, company[0]!)).liability).toBe(0n);
      expect(await store.tokenCustodyRequirement(network, company[0]!, assetMint)).toMatchObject({
        liability: 101n,
        minimumSlot: 1000,
      });
      if (hsol)
        expect((await store.balances(network, mint))[0]).toMatchObject({
          reserved: '0',
          spent: '1995000',
          available: '5000',
        });
      expect(await store.epoch(network, mint, 1)).toMatchObject({
        budget: '101',
        allocated: '100',
        carry: '1',
        asset_mint: assetMint,
      });
      expect((await view()).holderClaim).toEqual({ amount: '75', throughEpoch: '1', assetMint });
      const claim = {
        networkGenesis: network,
        mint,
        wallet: fixture.owners[0]!.publicKey.toBase58(),
        epoch: 1,
        assetMint,
        amount: 75n,
        requestId: randomUUID(),
        authorizationDigest: 'a'.repeat(64),
      };
      await expect(store.requestClaim({ ...claim, assetMint: SOL_REWARD_MINT })).rejects.toThrow(
        'asset'
      );
      const { job: payout } = await prepare(await store.requestClaim(claim), {
        quoteMint,
        payoutMint: assetMint,
      });
      const payment = effect(payout, { operatingCostLamports: 5000n });
      await store.settle(payout.id, payment);
      await store.settle(payout.id, payment);
      expect(await store.tokenCustodyRequirement(network, company[0]!, assetMint)).toMatchObject({
        liability: 26n,
      });
      expect((await view()).paidLamports).toBe('75');
    } finally {
      vi.unstubAllEnvs();
    }
  }
);
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
