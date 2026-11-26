import { PublicKey } from '@solana/web3.js';
import { isHsolMode, payoutMintFor } from '@/lib/feeModes';
import { isCashbackMode, isMskdMode, type LaunchMode } from '@/lib/launchModes';
import { HSOL_REWARD_MINT, SOL_REWARD_MINT } from '@/lib/rewards';
import { NETWORK_GENESIS } from '../../../../../scripts/network-policy.cjs';

export const MAXIMUM_MSKD_CONVERSION_LAMPORTS = 1_000_000_000n;
export const MSKD_QUOTE_LIFETIME_MS = 20_000;
export const MSKD_SLIPPAGE_BPS = 100;
export const HSOL_BRIDGE_POOL = new PublicKey('6a7EnjAoiRBbminKkWPdytMFFf5ogjLutqwpvAVyZ89j');

export function mskdPayoutMint(genesis: string) {
  const network = genesis === NETWORK_GENESIS['mainnet-beta'] ? 'mainnet-beta' : 'devnet';
  const value = payoutMintFor('mskd', network, process.env);
  if (!value) return null;
  const mint = new PublicKey(value);
  if (mint.equals(PublicKey.default) || value === SOL_REWARD_MINT || mint.toBase58() !== value)
    throw new Error('Invalid MSKD payout mint');
  return mint;
}

export function mskdConversionPool() {
  const value = process.env.MSKD_PAYOUT_POOL;
  return value ? new PublicKey(value) : null;
}

export function signedRewardMint(mode: LaunchMode, genesis: string): string | null | undefined {
  if (isMskdMode(mode)) return mskdPayoutMint(genesis)?.toBase58() ?? null;
  if (isHsolMode(mode)) return HSOL_REWARD_MINT;
  if (isCashbackMode(mode)) return SOL_REWARD_MINT;
  return undefined;
}

export function requireFreshMskdQuote(created: unknown, now = Date.now()) {
  if (
    typeof created !== 'number' ||
    !Number.isSafeInteger(created) ||
    created > now ||
    now - created > MSKD_QUOTE_LIFETIME_MS
  )
    throw new Error('MSKD conversion quote has expired');
}
