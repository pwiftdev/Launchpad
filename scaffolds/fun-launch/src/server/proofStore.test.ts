import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { fixtureGenesis, fixtureWallet } from './economics/financialFixtures';
import { MaskedTreasuryProof } from './economics/maskedTreasuryProof';
import { ProofStore } from './proofStore';
import { WalletStore } from './economics/walletStore';
import { moneroAddressFrom } from '@/lib/monero';

const key = () => fixtureWallet().publicKey.toBase58();
const migrations = new URL('../../../../scripts/migrations/', import.meta.url);
const config = key(),
  mint = key(),
  other = key(),
  collector = key(),
  treasury = key(),
  mskd = key();
const hex = (seed: string, length = 64) => seed.repeat(length).slice(0, length);

// A stagenet treasury whose view key really belongs to its address.
const VIEW_SCALAR = 1234567890123456789n;
const VIEW_KEY = Buffer.from(VIEW_SCALAR.toString(16).padStart(64, '0'), 'hex')
  .reverse()
  .toString('hex');
const ADDRESS = moneroAddressFrom(
  24,
  new Uint8Array([
    ...ed25519.Point.BASE.multiply(42n).toBytes(),
    ...ed25519.Point.BASE.multiply(VIEW_SCALAR).toBytes(),
  ])
);

let pg: PGlite, db: Pick<Pool, 'query'>;
beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  db = {
    query: async (sql: string, args?: unknown[]) => {
      const r = await pg.query(sql, args);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
  } as unknown as Pick<Pool, 'query'>;
}, 60_000);
afterAll(async () => {
  await pg.close();
});

async function finalized(
  coin: string,
  kind: 'collect' | 'creator_claim' | 'buyback',
  lamports: number,
  at: string,
  recipient: string | null = null,
  burned = 0
) {
  const id = randomUUID(),
    signature = `sig${randomUUID().replaceAll('-', '')}`;
  const collect = kind === 'collect';
  await pg.query(
    `INSERT INTO wallet_jobs(id,network_genesis,mint,kind,intent_key,bucket,recipient,lamports,status,transaction_base64,
       message_digest,prepared_slot,last_valid_block_height,signature,finalized_slot,received_lamports,burned_tokens)
     VALUES($1,$2,$3,$4,$12,$5,$6,$7,'finalized','AA==',$8,1,2,$9,3,$10,$11)`,
    [
      id,
      fixtureGenesis,
      coin,
      kind,
      collect ? null : kind === 'buyback' ? 'rinse_buyback' : 'creator',
      recipient,
      collect ? 0 : lamports,
      'd'.repeat(64),
      signature,
      collect ? lamports : 0,
      burned,
      `intent-${id}`,
    ]
  );
  await pg.query(
    `INSERT INTO wallet_settlements(job_id,network_genesis,mint,kind,signature,message_digest,finalized_slot,
       received_lamports,paid_lamports,actual_spent_lamports,burned_tokens,created_at)
     VALUES($1,$2,$3,$4,$5,$6,3,$7,$8,$9,$10,$11)`,
    [
      id,
      fixtureGenesis,
      coin,
      kind,
      signature,
      'd'.repeat(64),
      collect ? lamports : 0,
      kind === 'creator_claim' ? lamports : 0,
      collect ? 0 : lamports,
      burned,
      at,
    ]
  );
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
  for (const coin of [mint, mskd, other])
    await pg.query(
      `INSERT INTO launch_coins(network_genesis,mint,dbc_pool,config_key,original_deployer,mode,recipient,policy_version,activation_point,activation_time,creation_signature,finalized_slot,creator_share_bps)
       VALUES($1,$2,$3,$4,$5,'masked',$6,'masked-v1',1,1,$7,1,5000)`,
      [fixtureGenesis, coin, key(), config, key(), collector, `creation-${coin}`]
    );
});

describe('public proof', () => {
  it('totals each UTC day and counts each paid wallet once', async () => {
    const creator = key();
    await finalized(mint, 'collect', 3_000_000_000, '2026-11-26T10:00:00Z');
    await finalized(other, 'collect', 1_000_000_000, '2026-11-26T23:59:00Z');
    await finalized(mint, 'creator_claim', 500_000_000, '2026-11-26T12:00:00Z', creator);
    await finalized(other, 'creator_claim', 250_000_000, '2026-11-26T13:00:00Z', creator);
    await finalized(mskd, 'buyback', 100_000_000, '2026-11-25T08:00:00Z', null, 4_000_000);
    await pg.query(
      `INSERT INTO masked_xmr_inflows(network_genesis,txid,amount_atomic,height,received_at) VALUES($1,$2,5000000000000,10,'2026-11-26T01:00:00Z')`,
      [fixtureGenesis, hex('e')]
    );
    const days = await new ProofStore(db).days(
      fixtureGenesis,
      mskd,
      new Date('2026-11-20T00:00:00Z')
    );
    expect(days.map((day) => day.day)).toEqual(['2026-11-26', '2026-11-25']);
    expect(days[0]).toMatchObject({
      feesCollectedLamports: '4000000000',
      collections: 2,
      solPaidLamports: '750000000',
      xmrReceivedAtomic: '5000000000000',
      peoplePaid: 1,
    });
    expect(days[1]).toMatchObject({
      burns: 1,
      mskdBoughtLamports: '100000000',
      mskdBurnedTokens: '4000000',
    });
    const receipts = await new ProofStore(db).receipts(fixtureGenesis, mskd);
    expect(receipts.collections).toHaveLength(2);
    expect(receipts.burns).toMatchObject([{ lamports: '100000000', tokens: '4000000' }]);
  });

  it('publishes a matching view key, new incoming XMR and changed key images only', async () => {
    const wallet = {
      address: vi.fn(async () => ADDRESS),
      viewKey: vi.fn(async () => VIEW_KEY),
      exportKeyImages: vi.fn(async () => ({
        offset: 0,
        signedKeyImages: [{ key_image: hex('a'), signature: hex('b', 128) }],
      })),
      incoming: vi.fn(async () => [
        { txid: hex('c'), amount: 2_000_000_000_000n, height: 100, receivedAt: new Date() },
      ]),
    };
    const proof = new MaskedTreasuryProof(wallet, fixtureGenesis, 'stagenet', {
      db,
      restoreHeight: 90,
    });
    expect(await proof.publish(120)).toMatchObject({ received: 1, keyImages: 1, newExport: true });
    expect(wallet.incoming).toHaveBeenLastCalledWith(90);
    expect(await proof.publish(121)).toMatchObject({ received: 0, newExport: false });
    expect(wallet.incoming).toHaveBeenLastCalledWith(100);

    const store = new ProofStore(db);
    expect(await store.treasury(fixtureGenesis, 'stagenet')).toMatchObject({
      address: ADDRESS,
      viewKey: VIEW_KEY,
      restoreHeight: '90',
      verified: true,
      keyImages: { count: 1, walletHeight: '120' },
    });
    expect(await store.latestKeyImages(fixtureGenesis)).toMatchObject({
      offset: 0,
      signed_key_images: [{ key_image: hex('a') }],
    });

    wallet.viewKey.mockResolvedValueOnce(hex('1'));
    await expect(proof.publish(122)).rejects.toThrow('does not match');
  });

  it('lists who controls what from the configured wallets and launch configs', async () => {
    const controls = await new ProofStore(db).controls(
      fixtureGenesis,
      { collector, treasury },
      mskd,
      ADDRESS
    );
    expect(controls.map((control) => [control.label, control.address])).toEqual([
      ['Company fee wallet', collector],
      ['Company treasury', treasury],
      ['Masked launch config', config],
      ['$MSKD token', mskd],
      ['Monero treasury', ADDRESS],
      ['Meteora bonding curve program', expect.any(String)],
      ['Meteora DAMM v2 program', expect.any(String)],
    ]);
  });

  it('numbers each burn and keeps running totals for its receipt', async () => {
    await finalized(mskd, 'buyback', 100_000_000, '2026-11-24T08:00:00Z', null, 4_000_000);
    await finalized(mskd, 'buyback', 200_000_000, '2026-11-25T08:00:00Z', null, 6_000_000);
    await pg.query(
      `INSERT INTO masked_mskd_buyback_transfers(id,network_genesis,source_mint,target_mint,lamports,created_at)
       VALUES($1,$2,$3,$4,300000000,'2026-11-24T12:00:00Z')`,
      [randomUUID(), fixtureGenesis, mint, mskd]
    );
    const signature = (
      await pg.query<{ signature: string }>(
        `SELECT signature FROM wallet_settlements WHERE kind='buyback' ORDER BY created_at DESC LIMIT 1`
      )
    ).rows[0]!.signature;
    expect(await new ProofStore(db).burn(fixtureGenesis, mskd, signature)).toMatchObject({
      number: 2,
      totalBurns: 2,
      lamports: '200000000',
      tokens: '6000000',
      burnedToDateTokens: '10000000',
      fundedByMaskedLamports: '300000000',
    });
    expect(await new ProofStore(db).burn(fixtureGenesis, mint, signature)).toBeNull();
  });

  it('reports whether the $MSKD burn can run for this collector', async () => {
    vi.stubEnv('MASKED_TEST_BUYBACK_MINT', mskd);
    try {
      const store = new WalletStore(db as never);
      expect(await store.mskdBuybackReadiness(fixtureGenesis, collector)).toMatchObject({
        ready: true,
        target: mskd,
        problems: [],
      });
      const elsewhere = await store.mskdBuybackReadiness(fixtureGenesis, key());
      expect(elsewhere.ready).toBe(false);
      expect(elsewhere.problems[0]).toContain('another collector');
      vi.stubEnv('MASKED_TEST_BUYBACK_MINT', key());
      expect((await store.mskdBuybackReadiness(fixtureGenesis, collector)).problems[0]).toContain(
        'not registered'
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
