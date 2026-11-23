import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { connection, getCoin, networkGenesis } from './dbc';
import { loadMigratedPool } from './damm';
import { configuredVaultProgram } from './launchConfig';
import { vaultAddresses } from '@/lib/vault/client';
import { registeredConfig } from './launchRegistry';
import { cachedHolders, readHolders } from './holders';
import { isWalletPolicy } from '@/lib/launchModes';
export async function getCoinHolders(mint: PublicKey) {
  const found = await getCoin(mint.toBase58(), { fresh: false });
  if (!found) return null;
  const genesis = await networkGenesis();
  let custody: PublicKey | undefined;
  if (isWalletPolicy(found.coin.feePolicyVersion ?? '')) {
    const policy = await registeredConfig(genesis, found.coin.configKey!);
    if (!policy || policy.policy_version !== found.coin.feePolicyVersion)
      throw new Error('Missing immutable collector policy');
    custody = getAssociatedTokenAddressSync(mint, new PublicKey(policy.expected_fee_claimer));
  } else if (process.env.VAULT_PROGRAM_ID || process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID)
    custody = vaultAddresses(configuredVaultProgram(), mint).tokenAccount;
  return cachedHolders(
    `${genesis}:${found.coin.configKey ?? ''}:${custody?.toBase58() ?? ''}:${mint.toBase58()}`,
    async () => {
      const state = found.account.poolState,
        excluded = new Map([[state.baseVault.toBase58(), state.baseVault]]);
      if (found.coin.isMigrated) {
        const migrated = await loadMigratedPool(connection, found.config, mint);
        const baseVault = migrated.state.tokenAMint.equals(mint)
          ? migrated.state.tokenAVault
          : migrated.state.tokenBVault;
        excluded.set(baseVault.toBase58(), baseVault);
      }
      if (custody) excluded.set(custody.toBase58(), custody);
      return readHolders(connection, {
        mint,
        creator: found.coin.creator,
        excludedAccounts: [...excluded.values()],
      });
    }
  );
}
