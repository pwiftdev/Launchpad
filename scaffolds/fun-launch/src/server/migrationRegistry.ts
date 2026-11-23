import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { BorshCoder, type Idl } from '@coral-xyz/anchor';
import {
  DynamicBondingCurveClient,
  DynamicBondingCurveIdl,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { connection, networkGenesis } from './dbc';
import { assertReleasedMigrationPolicy, loadMigratedPool, migratedPoolAddress } from './damm';
import { registeredCoin } from './launchRegistry';
import { database } from './database';
const coder = new BorshCoder(DynamicBondingCurveIdl as unknown as Idl);

export async function migrationHistoryBoundary(genesis: string, mint: string) {
  const result = await database().query<{ creation_signature: string; creation_slot: string }>(
    'SELECT creation_signature,creation_slot FROM launch_migration_proofs WHERE network_genesis=$1 AND mint=$2',
    [genesis, mint]
  );
  const row = result.rows[0];
  return row ? { signature: row.creation_signature, slot: row.creation_slot } : null;
}

/** A discovery slot is not a history boundary: require the actual finalized initialization transaction. */
export async function recordMigrationTransaction(genesis: string, mint: string, signature: string) {
  const coin = await registeredCoin(genesis, mint);
  if (!coin || (await networkGenesis(true)) !== genesis) throw new Error('Unknown network or coin');
  const tx = await connection.getTransaction(signature, {
    commitment: 'finalized',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) return null;
  if (!tx.meta || tx.meta.err || tx.transaction.signatures[0] !== signature)
    throw new Error('Migration transaction did not succeed');
  const definition = DynamicBondingCurveIdl.instructions.find(
    (ix) => ix.name === 'migration_damm_v2'
  );
  if (!definition) throw new Error('Missing migration instruction schema');
  const keys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: tx.meta.loadedAddresses,
  });
  let target: string | undefined;
  for (const instruction of tx.transaction.message.compiledInstructions) {
    if (!keys.get(instruction.programIdIndex)?.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) continue;
    const decoded = coder.instruction.decode(Buffer.from(instruction.data));
    if (decoded?.name !== definition.name) continue;
    const account = (name: string) => {
      const offset = definition.accounts.findIndex((a) => a.name === name),
        at = instruction.accountKeyIndexes[offset];
      return at === undefined ? undefined : keys.get(at)?.toBase58();
    };
    if (
      account('base_mint') === mint &&
      account('virtual_pool') === coin.dbc_pool &&
      account('config') === coin.config_key
    )
      target = account('pool');
  }
  if (!target || !(await verifiedFinancialPool(genesis, mint, target)))
    throw new Error('Finalized migration destination does not match the coin');
  if ((await networkGenesis(true)) !== genesis) throw new Error('Migration network changed');
  await database().query(
    `INSERT INTO launch_migration_proofs(network_genesis,mint,creation_signature,creation_slot)
     VALUES($1,$2,$3,$4) ON CONFLICT(network_genesis,mint) DO NOTHING`,
    [genesis, mint, signature, tx.slot]
  );
  const boundary = await migrationHistoryBoundary(genesis, mint);
  if (!boundary || boundary.signature !== signature)
    throw new Error('Migration proof conflicts with immutable history');
  return boundary;
}

/** Bounded keeper discovery; hitting the cap leaves history incomplete, never assumed complete. */
export async function discoverMigrationBoundary(genesis: string, mint: string, maxPages = 10) {
  const existing = await migrationHistoryBoundary(genesis, mint);
  if (existing) return existing;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100)
    throw new Error('Invalid migration discovery bound');
  let mapped = await database().query<{ damm_pool: string; migration_activation_point: string }>(
    'SELECT damm_pool,migration_activation_point FROM launch_migrations WHERE network_genesis=$1 AND mint=$2',
    [genesis, mint]
  );
  // The first worker run may start from the native binding before any HTTP quote/claim
  // has registered its canonical mapping. Establish it before trying to find a boundary.
  if (!mapped.rows[0]) {
    const coin = await registeredCoin(genesis, mint);
    if (!coin) return null;
    const client = new DynamicBondingCurveClient(connection, 'finalized');
    const config = await client.state.getPoolConfig(new PublicKey(coin.config_key));
    if (
      !config ||
      !(await verifiedFinancialPool(
        genesis,
        mint,
        migratedPoolAddress(config, new PublicKey(mint)).toBase58()
      ))
    )
      return null;
    mapped = await database().query<{ damm_pool: string; migration_activation_point: string }>(
      'SELECT damm_pool,migration_activation_point FROM launch_migrations WHERE network_genesis=$1 AND mint=$2',
      [genesis, mint]
    );
  }
  const row = mapped.rows[0];
  if (!row) return null;
  const activation = Number(row.migration_activation_point);
  let before: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const signatures = await connection.getSignaturesForAddress(
      new PublicKey(row.damm_pool),
      { before, limit: 1000 },
      'finalized'
    );
    for (const item of signatures) {
      if (
        item.err ||
        typeof item.blockTime !== 'number' ||
        Math.abs(item.blockTime - activation) > 120
      )
        continue;
      try {
        const proof = await recordMigrationTransaction(genesis, mint, item.signature);
        if (proof) return proof;
      } catch {
        /* An ordinary swap is not a creation proof. */
      }
    }
    if (signatures.length < 1000) return null;
    before = signatures.at(-1)?.signature;
    if (!before) return null;
  }
  return null;
}

/** Financial ingestion accepts only the original DBC pool or a finalized, deterministic migration. */
export async function verifiedFinancialPool(
  genesis: string,
  mint: string,
  pool: string
): Promise<boolean> {
  if ((await networkGenesis(true)) !== genesis) return false;
  const coin = await registeredCoin(genesis, mint);
  if (!coin) return false;
  if (coin.dbc_pool === pool) return true;
  const client = new DynamicBondingCurveClient(connection, 'finalized');
  const dbcPool = await client.state.getPoolByBaseMint(new PublicKey(mint));
  if (
    !dbcPool ||
    dbcPool.publicKey.toBase58() !== coin.dbc_pool ||
    dbcPool.account.poolState.config.toBase58() !== coin.config_key ||
    Number(dbcPool.account.poolState.isMigrated) !== 1
  )
    return false;
  const config = await client.state.getPoolConfig(new PublicKey(coin.config_key));
  if (!config) return false;
  const migrated = await loadMigratedPool(connection, config, new PublicKey(mint), 'finalized');
  if (migrated.address.toBase58() !== pool) return false;
  if (['rinse-v1', 'wallet-v1', 'bond-v1', 'mskd-v1', 'dev-v1', 'cashback-v1'].includes(coin.policy_version))
    assertReleasedMigrationPolicy(
      migrated.state,
      new PublicKey(mint),
      coin.policy_version === 'bond-v1' ? 100 : 125,
      config.quoteMint
    );
  const activation = migrated.state.activationPoint.toString();
  if (
    migrated.state.activationType !== 1 ||
    BigInt(activation) < BigInt(coin.activation_time ?? coin.activation_point)
  )
    return false;
  const snapshot = await connection.getAccountInfoAndContext(migrated.address, 'finalized');
  if (!snapshot.value) return false;
  const digest = createHash('sha256').update(snapshot.value.data).digest('hex');
  if ((await networkGenesis(true)) !== genesis) return false;
  await database().query(
    `INSERT INTO launch_migrations(network_genesis,mint,damm_pool,migration_activation_point,finalized_slot,account_digest)
     VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(network_genesis,mint) DO NOTHING`,
    [genesis, mint, pool, activation, snapshot.context.slot, digest]
  );
  const result = await database().query<{ damm_pool: string }>(
    'SELECT damm_pool FROM launch_migrations WHERE network_genesis=$1 AND mint=$2',
    [genesis, mint]
  );
  return result.rows[0]?.damm_pool === pool;
}
