import modePolicy from '@/constants/modePolicy.json';
import { formatTokenUnits } from './tokenUnits';

export const SOL_REWARD_MINT = modePolicy.quotes.sol.mint;
export const HSOL_REWARD_MINT = modePolicy.quotes.hsol.mint;
export const MINIMUM_HOLDER_PAYOUT_LAMPORTS = 1_000_000n;
export const rewardHourEnd = (epoch: string) => new Date((Number(epoch) + 1) * 3_600_000);

export type ClaimAuthorization = {
  networkGenesis: string;
  mint: string;
  wallet: string;
  epoch: string | null;
  amount: string;
  requestId: string;
  issuedAt: number;
  assetMint?: string;
};
/** This message requests one server-paid transfer to the signing wallet. */
export function claimAuthorizationMessage(origin: string, input: ClaimAuthorization): string {
  if (input.assetMint === HSOL_REWARD_MINT && input.epoch === null) {
    return [
      `Request an hSOL creator payout on ${origin}`,
      'Policy: hsol-creator-payout-v1',
      `Network genesis: ${input.networkGenesis}`,
      `Destination wallet: ${input.wallet}`,
      `Launch mint: ${input.mint}`,
      `Payout asset: ${input.assetMint}`,
      `Amount: ${formatTokenUnits(input.amount, modePolicy.quotes.hsol.decimals)} hSOL (${input.amount} base units)`,
      `Request: ${input.requestId}`,
      `Issued at: ${input.issuedAt}`,
      'Send this reward only to the wallet above. No transaction signature or token approval is requested.',
    ].join('\n');
  }
  if (input.assetMint) {
    const asset =
      input.assetMint === SOL_REWARD_MINT
        ? 'SOL'
        : input.assetMint === HSOL_REWARD_MINT
          ? 'hSOL'
          : 'wXMR';
    const decimals = asset === 'wXMR' ? modePolicy.payouts.wxmr.decimals : 9;
    if (input.epoch === null) throw new Error('Holder payout requires a reward-hour cutoff');
    const through = rewardHourEnd(input.epoch).toISOString();
    return [
      `Request a ${asset} holder payout on ${origin}`,
      asset === 'hSOL' ? 'Policy: hsol-cashback-payout-v1' : 'Policy: mskd-holder-payout-v1',
      `Network genesis: ${input.networkGenesis}`,
      `Destination wallet: ${input.wallet}`,
      `Launch mint: ${input.mint}`,
      `Payout asset: ${input.assetMint}`,
      `Unpaid reward hours ending by: ${through}`,
      `Amount: ${formatTokenUnits(input.amount, decimals)} ${asset} (${input.amount} base units)`,
      `Request: ${input.requestId}`,
      `Issued at: ${input.issuedAt}`,
      'Send this reward only to the wallet above. No transaction signature or token approval is requested.',
    ].join('\n');
  }
  return [
    `Request a SOL reward payout on ${origin}`,
    'Policy: rinsed-wallet-payout-v1',
    `Network genesis: ${input.networkGenesis}`,
    `Wallet: ${input.wallet}`,
    `Mint: ${input.mint}`,
    `Epoch: ${input.epoch ?? 'creator'}`,
    `Amount (lamports): ${input.amount}`,
    `Request: ${input.requestId}`,
    `Issued at: ${input.issuedAt}`,
    'Send this reward only to the wallet above. No transaction signature or token approval is requested.',
  ].join('\n');
}
export type RewardReceipt = {
  epoch: string;
  lamports: string;
  status: 'available' | 'pending' | 'paid';
  jobId: string | null;
  jobStatus?: string | null;
  signature: string | null;
  snapshotSlot?: string;
  snapshotDigest?: string;
  conversionSignature?: string;
};
export type RewardsView = {
  payoutMethod?: 'server-paid';
  request?: RewardPayout | null;
  networkGenesis?: string;
  status: 'ready' | 'unfunded' | 'unavailable';
  mode: import('@/lib/launchModes').LaunchMode | null;
  availableLamports: string;
  reservedLamports?: string;
  paidLamports?: string;
  holderClaim?: { amount: string; throughEpoch: string; assetMint: string } | null;
  creatorReceipts?: { lamports: string; signature: string; finalizedSlot: string }[];
  nextEpoch?: string | null;
  epochs: RewardReceipt[];
  creatorJob?: { id: string; signature: string | null; status?: string; amount?: string } | null;
};

export type RewardPayout = {
  id: string;
  status: string;
  signature: string | null;
  amount: string;
  assetMint?: string;
  requestId?: string;
};
