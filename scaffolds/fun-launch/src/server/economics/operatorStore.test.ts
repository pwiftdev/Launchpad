import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { SystemProgram, VersionedTransaction } from '@solana/web3.js';
import {
  fixtureGenesis,
  fixtureWallet,
  transactionFixture,
  unsignedTransaction,
} from './financialFixtures';
import { verifyOperatorRefresh } from './operatorRecovery';
import { operatorPlan, prepareOperatorPlan, refreshUnsignedOperatorPlan } from './operatorStore';

const shared = vi.hoisted(() => ({ pool: null as unknown }));
vi.mock('../database', () => ({ database: () => shared.pool }));
let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  const migration = (name: string) =>
    readFileSync(new URL(`../../../../../scripts/migrations/${name}`, import.meta.url), 'utf8');
  for (const name of ['003-launch-registry.sql', '004-financial.sql', '006-financial-recovery.sql'])
    await db.exec(migration(name));
  let queue = Promise.resolve();
  const query = async (sql: string, parameters?: unknown[]) => {
    const row = await db.query(sql, parameters);
    return { rows: row.rows, rowCount: row.affectedRows ?? row.rows.length };
  };
  shared.pool = {
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
  };
}, 20000);
afterAll(async () => {
  await db?.close();
});

describe('durable unsigned operator refresh', () => {
  it('archives the old message atomically and permits only one refresh after competing retries', async () => {
    const wallet = fixtureWallet(),
      mint = fixtureWallet().publicKey,
      config = fixtureWallet().publicKey,
      program = fixtureWallet().publicKey;
    await db.query(
      `INSERT INTO launch_configs(network_genesis,config_key,policy_version,expected_fee_claimer,expected_leftover_receiver,config_digest,verified_slot)
      VALUES($1,$2,'rinse-v1',$3,$3,$4,1)`,
      [fixtureGenesis, config.toBase58(), wallet.publicKey.toBase58(), 'a'.repeat(64)]
    );
    await db.query(
      `INSERT INTO launch_coins(network_genesis,mint,dbc_pool,config_key,original_deployer,mode,recipient,policy_version,
      activation_point,creation_signature,finalized_slot) VALUES($1,$2,$3,$4,$3,'creator',$3,'rinse-v1',1000,'creation',1)`,
      [fixtureGenesis, mint.toBase58(), wallet.publicKey.toBase58(), config.toBase58()]
    );
    const fixture = transactionFixture(
      [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: mint, lamports: 1 })],
      wallet
    );
    const plan = await prepareOperatorPlan({
      networkGenesis: fixtureGenesis,
      mint: mint.toBase58(),
      kind: 'setup',
      intentKey: 'setup-once',
      transactionBase64: unsignedTransaction(fixture.tx),
      lastValidBlockHeight: 1000,
      metadata: {},
    });
    fixture.rpc.getBlockHeight = async () => 1001;
    fixture.rpc.isBlockhashValid = async () => ({ context: { slot: 1000 }, value: false });
    fixture.rpc.getLatestBlockhash = async () => ({
      blockhash: fixtureWallet().publicKey.toBase58(),
      lastValidBlockHeight: 1100,
    });
    const proof = await verifyOperatorRefresh(fixture.rpc, plan, program.toBase58());
    const results = await Promise.allSettled([
      refreshUnsignedOperatorPlan(proof),
      refreshUnsignedOperatorPlan(proof),
    ]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((row) => row.status === 'rejected')).toHaveLength(1);
    const current = await operatorPlan(plan.id);
    expect(current?.status).toBe('prepared');
    expect(current?.signature).toBeNull();
    expect(current?.message_digest).toBe(proof.messageDigest);
    const old = VersionedTransaction.deserialize(Buffer.from(plan.transaction_base64, 'base64'));
    const fresh = VersionedTransaction.deserialize(
      Buffer.from(current!.transaction_base64, 'base64')
    );
    fresh.message.recentBlockhash = old.message.recentBlockhash;
    expect(Buffer.from(fresh.serialize()).toString('base64')).toBe(plan.transaction_base64);
    expect((await db.query('SELECT * FROM financial_operator_attempts')).rows).toHaveLength(1);
    await expect(
      db.query('UPDATE financial_operator_attempts SET last_valid_block_height=0')
    ).rejects.toThrow('append-only');
    await expect(refreshUnsignedOperatorPlan({ ...proof })).rejects.toThrow('independently');
    fixture.rpc.getBlockHeight = async () => 1101;
    fixture.rpc.getLatestBlockhash = async () => ({
      blockhash: fixtureWallet().publicKey.toBase58(),
      lastValidBlockHeight: 1200,
    });
    const nextProof = await verifyOperatorRefresh(fixture.rpc, current!, program.toBase58());
    await db.query("UPDATE financial_operator_plans SET status='signed',signature=$2 WHERE id=$1", [
      plan.id,
      fixture.signature,
    ]);
    await expect(refreshUnsignedOperatorPlan(nextProof)).rejects.toThrow('state changed');
    expect((await db.query('SELECT * FROM financial_operator_attempts')).rows).toHaveLength(1);
  });
});
