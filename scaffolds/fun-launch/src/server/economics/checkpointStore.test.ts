import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import bs58 from 'bs58';
import { fixtureGenesis, fixtureWallet } from './financialFixtures';
import { FinancialDammCheckpointStore } from './checkpointStore';
import {
  sealDammCheckpoint,
  verifyDammCheckpoint,
  type DammCheckpointIdentity,
  type UnsignedDammCheckpoint,
} from './dammCheckpoint';

let db: PGlite, store: FinancialDammCheckpointStore;
const oldKey = process.env.FINANCIAL_CHECKPOINT_HMAC_KEY,
  oldId = process.env.FINANCIAL_CHECKPOINT_KEY_ID;
const wallet = fixtureWallet().publicKey,
  config = fixtureWallet().publicKey;
const identity: DammCheckpointIdentity = {
  networkGenesis: fixtureGenesis,
  programId: fixtureWallet().publicKey.toBase58(),
  mint: fixtureWallet().publicKey.toBase58(),
  pool: fixtureWallet().publicKey.toBase58(),
  position: fixtureWallet().publicKey.toBase58(),
  classificationPolicy: 'q128-growth-v1',
};
const signature = (value: number) => bs58.encode(Buffer.alloc(64, value));
function unsigned(
  slot: number,
  index: number,
  previous: string | null,
  event: number
): UnsignedDammCheckpoint {
  return {
    ...identity,
    version: 1,
    cursorSignature: signature(slot % 255),
    cursorSlot: slot,
    cursorTransactionIndex: index,
    previousCheckpointDigest: previous,
    rollingHistoryDigest: 'a'.repeat(64),
    verifiedSnapshotSlot: slot + 1,
    poolDigest: 'b'.repeat(64),
    positionDigest: 'c'.repeat(64),
    payload: {
      state: { growth: '100', liquidity: '50' },
      ownedLiquidity: '50',
      cursorMessageDigest: 'd'.repeat(64),
      cursorClaimWitness: ['9'],
      attributions: [
        {
          signature: signature(event),
          instructionIndex: 0,
          eventIndex: 1,
          raw: '10',
          realized: '9',
          externalLpExcluded: '0',
          roundingLoss: '1',
          claimSignature: signature(slot % 255),
        },
      ],
      windows: [],
    },
  };
}
beforeAll(async () => {
  process.env.FINANCIAL_CHECKPOINT_HMAC_KEY = Buffer.alloc(32, 19).toString('base64');
  process.env.FINANCIAL_CHECKPOINT_KEY_ID = 'unit-store';
  db = new PGlite();
  await db.waitReady;
  for (const name of [
    '003-launch-registry.sql',
    '004-financial.sql',
    '013-damm-replay-checkpoints.sql',
  ])
    await db.exec(
      readFileSync(new URL(`../../../../../scripts/migrations/${name}`, import.meta.url), 'utf8')
    );
  await db.query(
    `INSERT INTO launch_configs(network_genesis,config_key,policy_version,expected_fee_claimer,expected_leftover_receiver,config_digest,verified_slot)
    VALUES($1,$2,'rinse-v1',$3,$3,$4,1)`,
    [fixtureGenesis, config.toBase58(), wallet.toBase58(), 'e'.repeat(64)]
  );
  await db.query(
    `INSERT INTO launch_coins(network_genesis,mint,dbc_pool,config_key,original_deployer,mode,recipient,policy_version,activation_point,creation_signature,finalized_slot)
    VALUES($1,$2,$3,$4,$5,'creator',$5,'rinse-v1',1,'creation',1)`,
    [
      fixtureGenesis,
      identity.mint,
      fixtureWallet().publicKey.toBase58(),
      config.toBase58(),
      wallet.toBase58(),
    ]
  );
  let queue = Promise.resolve();
  const query = async (sql: string, parameters?: unknown[]) => {
    const row = await db.query(sql, parameters);
    return { rows: row.rows, rowCount: row.affectedRows ?? row.rows.length };
  };
  const pool = {
    query,
    connect: async () => {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      return { query, release };
    },
  } as unknown as Pick<Pool, 'query' | 'connect'>;
  store = new FinancialDammCheckpointStore(pool);
}, 20000);
afterAll(async () => {
  await db?.close();
  if (oldKey === undefined) delete process.env.FINANCIAL_CHECKPOINT_HMAC_KEY;
  else process.env.FINANCIAL_CHECKPOINT_HMAC_KEY = oldKey;
  if (oldId === undefined) delete process.env.FINANCIAL_CHECKPOINT_KEY_ID;
  else process.env.FINANCIAL_CHECKPOINT_KEY_ID = oldId;
});

describe('authenticated SQL replay checkpoints', () => {
  it('round-trips reordered JSONB, loads archived assignments and rejects concurrent forks/cursor regression without modifying old evidence', async () => {
    expect(await store.loadLatest(identity)).toBeNull();
    const first = sealDammCheckpoint(unsigned(100, 0, null, 1));
    await store.save(first);
    const loaded = await store.loadLatest(identity);
    expect(loaded?.digest).toBe(first.digest);
    const restored = verifyDammCheckpoint(JSON.parse(JSON.stringify(loaded)), identity);
    expect(restored.digest).toBe(first.digest);
    expect(
      (
        await store.loadAttributions(identity, [
          { signature: signature(1), instructionIndex: 0, eventIndex: 1 },
        ])
      )[0]?.digest
    ).toBe(first.digest);
    expect(
      await store.loadAttributions(identity, [
        { signature: signature(99), instructionIndex: 0, eventIndex: 1 },
      ])
    ).toEqual([]);
    const tampered = JSON.parse(JSON.stringify(loaded));
    tampered.payload.state.liquidity = '999';
    expect(() => verifyDammCheckpoint(tampered, identity)).toThrow();
    const second = sealDammCheckpoint(unsigned(200, 0, first.digest, 2));
    await store.save(second);
    expect((await store.loadLatest(identity))?.digest).toBe(second.digest);
    expect(
      (
        await store.loadAttributions(identity, [
          { signature: signature(1), instructionIndex: 0, eventIndex: 1 },
        ])
      )[0]?.digest
    ).toBe(first.digest);
    const a = sealDammCheckpoint(unsigned(300, 0, second.digest, 3)),
      b = sealDammCheckpoint(unsigned(301, 0, second.digest, 4));
    const raced = await Promise.allSettled([store.save(a), store.save(b)]);
    expect(raced.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter((row) => row.status === 'rejected')).toHaveLength(1);
    const latest = await store.loadLatest(identity);
    await store.save(verifyDammCheckpoint(latest!, identity));
    expect((await db.query('SELECT * FROM financial_damm_replay_checkpoints')).rows).toHaveLength(
      3
    );
    await expect(
      store.save(sealDammCheckpoint(unsigned(150, 0, latest!.digest, 5)))
    ).rejects.toThrow('regressed');
    await expect(store.save({ ...a } as typeof a)).rejects.toThrow();
    await expect(db.query('DELETE FROM financial_damm_replay_checkpoints')).rejects.toThrow(
      'append-only'
    );
  });
});
