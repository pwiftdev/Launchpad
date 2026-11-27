import { NETWORK } from '@/constants/network';
import type { Coin } from '@/lib/coin';

export function MskdV1Badge({ coin }: { coin: Coin }) {
  if (
    NETWORK !== 'mainnet-beta' ||
    coin.isDemo ||
    !coin.feePolicyVersion ||
    coin.feePolicyVersion === 'masked-v1'
  )
    return null;
  return (
    <span
      title="Launched before the Masked rebrand"
      className="shrink-0 rounded border border-white/15 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-300"
    >
      MSKDv1
    </span>
  );
}
