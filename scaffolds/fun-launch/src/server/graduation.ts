import { PublicKey, Transaction } from '@solana/web3.js';
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  deriveBaseKeyForLocker,
  deriveEscrow,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { connection, dbc, getCoin } from './dbc';

/** Returns wallet-signable transactions; existing treasury/operator keys never enter the web process. */
export async function buildGraduationTransactions(mint: PublicKey, payer: PublicKey) {
  const found = await getCoin(mint.toBase58());
  if (!found) throw new Error('Unknown launch');
  if (found.coin.isMigrated) return { status: 'migrated' as const, transactions: [] as string[] };
  const state = found.account.poolState,
    config = found.config;
  // Stock DBC migration is permissionless at threshold; graduation reaches the final fee floor.
  if (config.activationType !== 0 && config.activationType !== 1)
    throw new Error('Unsupported activation type');
  if (config.migrationOption !== 1 || state.quoteReserve.lt(config.migrationQuoteThreshold))
    throw new Error('Migration threshold has not been reached');
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption];
  if (!dammConfig) throw new Error('Unsupported migration configuration');
  const prepared: Transaction[] = [];
  if (
    config.lockedVestingConfig.amountPerPeriod.gtn(0) ||
    config.lockedVestingConfig.cliffUnlockAmount.gtn(0)
  ) {
    const escrow = deriveEscrow(deriveBaseKeyForLocker(new PublicKey(found.coin.pool)));
    if (!(await connection.getAccountInfo(escrow)))
      prepared.push(
        await dbc.migration.createLocker({ pool: new PublicKey(found.coin.pool), payer })
      );
  }
  const migration = await dbc.migration.migrateToDammV2({
    pool: new PublicKey(found.coin.pool),
    payer,
    dammConfig,
  });
  const block = await connection.getLatestBlockhashAndContext('confirmed');
  const { blockhash, lastValidBlockHeight } = block.value;
  for (const tx of prepared) {
    tx.feePayer = payer;
    tx.recentBlockhash = blockhash;
  }
  migration.transaction.feePayer = payer;
  migration.transaction.recentBlockhash = blockhash;
  migration.transaction.partialSign(
    migration.firstPositionNftKeypair,
    migration.secondPositionNftKeypair
  );
  prepared.push(migration.transaction);
  const transactions = prepared.map((tx) =>
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')
  );
  return {
    status: 'prepared' as const,
    transactions,
    lastValidBlockHeight,
    preparedSlot: block.context.slot,
  };
}
