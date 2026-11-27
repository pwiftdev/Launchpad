import { OFFICIAL_MSKD } from '@/constants/officialMskd';
import { NETWORK_GENESIS } from '../../../../../scripts/network-policy.cjs';

/** The coin Masked buybacks burn: official $MSKD on mainnet, a configured stand-in elsewhere. */
export function mskdBuybackMint(genesis: string, env = process.env): string | null {
  if (genesis === NETWORK_GENESIS['mainnet-beta']) return OFFICIAL_MSKD.mint;
  const value = env.MASKED_TEST_BUYBACK_MINT;
  return value && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) ? value : null;
}
