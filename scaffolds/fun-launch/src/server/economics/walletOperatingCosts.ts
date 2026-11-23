import type { Connection, PublicKey } from '@solana/web3.js';
import type { WalletJobKind } from './walletTypes';

/** Refunded WSOL rent needs cash during execution, but is not an expense against earned fees. */
export async function walletOperatingCosts(
  rpc: Pick<Connection, 'getMultipleAccountsInfo' | 'getMinimumBalanceForRentExemption'>,
  kind: WalletJobKind,
  maximumFee: bigint,
  tokenAta?: PublicKey,
  quoteAta?: PublicKey
) {
  if (maximumFee <= 0n) throw new Error('Positive operating fee bound required');
  if (kind.endsWith('_claim'))
    return { operatingCostLamports: maximumFee, temporaryFundingLamports: 0n };
  if (!tokenAta || !quoteAta) throw new Error('Explicit settlement token accounts required');
  const [accounts, rent] = await Promise.all([
    rpc.getMultipleAccountsInfo([tokenAta, quoteAta], 'finalized'),
    rpc.getMinimumBalanceForRentExemption(165, 'finalized'),
  ]);
  if (accounts.length !== 2 || !Number.isSafeInteger(rent) || rent <= 0)
    throw new Error('Token account rent is unavailable');
  const tokenRent = accounts[0] ? 0n : BigInt(rent);
  const quoteRent = accounts[1] ? 0n : BigInt(rent);
  return {
    operatingCostLamports: maximumFee + tokenRent + (kind === 'setup' ? quoteRent : 0n),
    temporaryFundingLamports: kind === 'setup' ? 0n : quoteRent,
  };
}
