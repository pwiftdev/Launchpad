import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { Coin } from '@/lib/coin';
import { connection, getCoin, networkGenesis } from './dbc';
import { loadMigratedPool } from './damm';
import { configuredVaultProgram } from './launchConfig';
import { vaultAddresses } from '@/lib/vault/client';
import { registeredConfig } from './launchRegistry';
import { isWalletPolicy } from '@/lib/launchModes';

/** Token accounts that hold a coin without being holders: pool vaults and fee custody. */
export async function holderExclusions(coin: Coin): Promise<string[]> {
  const mint = new PublicKey(coin.mint);
  const found = await getCoin(coin.mint, { fresh: false });
  if (!found) throw new Error('Coin is no longer discoverable');
  const excluded = new Set([found.account.poolState.baseVault.toBase58()]);
  if (found.coin.isMigrated) {
    const migrated = await loadMigratedPool(connection, found.config, mint);
    excluded.add(
      (migrated.state.tokenAMint.equals(mint)
        ? migrated.state.tokenAVault
        : migrated.state.tokenBVault
      ).toBase58()
    );
  }
  if (isWalletPolicy(found.coin.feePolicyVersion ?? '')) {
    const policy = await registeredConfig(await networkGenesis(), found.coin.configKey!);
    if (!policy || policy.policy_version !== found.coin.feePolicyVersion)
      throw new Error('Missing immutable collector policy');
    excluded.add(
      getAssociatedTokenAddressSync(mint, new PublicKey(policy.expected_fee_claimer)).toBase58()
    );
  } else if (process.env.VAULT_PROGRAM_ID || process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID)
    excluded.add(vaultAddresses(configuredVaultProgram(), mint).tokenAccount.toBase58());
  return [...excluded];
}
