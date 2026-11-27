import type { Connection, PublicKey } from '@solana/web3.js';
import type { WalletJobKind } from './walletTypes';

/** Refunded WSOL rent needs cash during execution, but is not an expense against earned fees. */
export async function walletOperatingCosts(
  rpc: Pick<Connection, 'getMultipleAccountsInfo' | 'getMinimumBalanceForRentExemption'>,
  kind: WalletJobKind,
  maximumFee: bigint,
  tokenAta?: PublicKey,
  quoteAta?: PublicKey,
  splQuote = false
) {
  if (maximumFee <= 0n) throw new Error('Positive operating fee bound required');
  if (kind === 'wxmr_claim') {
    // Temporary wrapped SOL, plus the company's and the recipient's wXMR accounts if missing.
    const rent = await rpc.getMinimumBalanceForRentExemption(165, 'finalized');
    if (!Number.isSafeInteger(rent) || rent <= 0) throw new Error('wXMR payout rent unavailable');
    return {
      operatingCostLamports: maximumFee + 2n * BigInt(rent),
      temporaryFundingLamports: BigInt(rent),
    };
  }
  if (kind.endsWith('_claim') && splQuote) {
    if (!quoteAta) throw new Error('Missing payout token account');
    const rent = await rpc.getMinimumBalanceForRentExemption(165, 'finalized');
    if (!Number.isSafeInteger(rent) || rent <= 0) throw new Error('Recipient rent unavailable');
    return { operatingCostLamports: maximumFee + BigInt(rent), temporaryFundingLamports: 0n };
  }
  if (kind.endsWith('_claim'))
    return { operatingCostLamports: maximumFee, temporaryFundingLamports: 0n };
  if (!tokenAta || !quoteAta) throw new Error('Explicit settlement token accounts required');
  if (kind === 'holder_conversion') {
    const rent = await rpc.getMinimumBalanceForRentExemption(165, 'finalized');
    if (!Number.isSafeInteger(rent) || rent <= 0) throw new Error('Conversion rent unavailable');
    return {
      operatingCostLamports: maximumFee + BigInt(rent),
      temporaryFundingLamports: BigInt(rent),
    };
  }
  const [accounts, rent] = await Promise.all([
    rpc.getMultipleAccountsInfo([tokenAta, quoteAta], 'finalized'),
    rpc.getMinimumBalanceForRentExemption(165, 'finalized'),
  ]);
  if (accounts.length !== 2 || !Number.isSafeInteger(rent) || rent <= 0)
    throw new Error('Token account rent is unavailable');
  const tokenRent = accounts[0] ? 0n : BigInt(rent);
  const quoteRent = accounts[1] ? 0n : BigInt(rent);
  return {
    operatingCostLamports: maximumFee + tokenRent + (kind === 'setup' || splQuote ? quoteRent : 0n),
    temporaryFundingLamports: kind === 'setup' || splQuote ? 0n : quoteRent,
  };
}
