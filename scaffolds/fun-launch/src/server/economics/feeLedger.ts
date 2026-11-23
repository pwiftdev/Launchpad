// Server-only accounting for the upcoming policy. These are accrued budgets, never proof of funding.
import { BENEFICIARY_NET_BPS, isFeeModeId } from '@/lib/feeModes';
import bondPolicy from '@/constants/bondPolicy.json';
import type { LaunchMode } from '@/lib/launchModes';
export type { LaunchMode } from '@/lib/launchModes';
export type FeeAllocation = {
  protocol: bigint;
  referral: bigint;
  rinseBuyback: bigint;
  creator: bigint;
  community: bigint;
  platform: bigint;
};

export function allocateExecutedFee({
  total,
  protocol,
  referral = 0n,
  activationTime,
  tradeTime,
  mode,
  previousPhaseNet = 0n,
  phase,
}: {
  total: bigint;
  protocol: bigint;
  referral?: bigint;
  activationTime: number;
  tradeTime: number;
  mode: LaunchMode;
  previousPhaseNet?: bigint;
  phase?: 'rinse' | 'post';
}): FeeAllocation {
  if (
    ![activationTime, tradeTime].every(Number.isSafeInteger) ||
    activationTime < 0 ||
    tradeTime < activationTime
  )
    throw new Error('Invalid confirmed trade time');
  if (mode !== 'bond' && mode !== 'creator' && mode !== 'community' && !isFeeModeId(mode))
    throw new Error('Unknown launch mode');
  if (phase !== undefined && phase !== 'rinse' && phase !== 'post')
    throw new Error('Unknown executed fee phase');
  if (
    total < 0n ||
    protocol < 0n ||
    referral < 0n ||
    previousPhaseNet < 0n ||
    protocol + referral > total
  )
    throw new Error('Invalid executed fee amounts');
  const available = total - protocol - referral;
  if (isFeeModeId(mode)) {
    const share = BigInt(BENEFICIARY_NET_BPS);
    const beneficiary = ((previousPhaseNet + available) * share) / 10_000n - (previousPhaseNet * share) / 10_000n;
    return { protocol, referral, rinseBuyback: 0n, creator: mode === 'dev' ? beneficiary : 0n,
      community: mode === 'dev' ? 0n : beneficiary, platform: available - beneficiary };
  }
  if (mode === 'bond' && phase === undefined)
    throw new Error('Bond it. fees require a verified DBC or DAMM phase');
  const rinse = phase === undefined ? tradeTime < activationTime + 27 : phase === 'rinse';
  // Cumulative phase carry makes deposits independent of event batching and avoids rounding games.
  const shareBps = rinse ? bondPolicy.preBondBuybackNetBps : bondPolicy.postBondCreatorNetBps;
  const destination =
    mode === 'bond'
      ? ((previousPhaseNet + available) * BigInt(shareBps)) / 10_000n -
        (previousPhaseNet * BigInt(shareBps)) / 10_000n
      : rinse
        ? ((previousPhaseNet + available) * 80n) / 100n - (previousPhaseNet * 80n) / 100n
        : (previousPhaseNet + available) / 2n - previousPhaseNet / 2n;
  return {
    protocol,
    referral,
    rinseBuyback: rinse ? destination : 0n,
    creator: !rinse && (mode === 'creator' || mode === 'bond') ? destination : 0n,
    community: !rinse && mode === 'community' ? destination : 0n,
    platform: available - destination,
  };
}

export function allocateHolderSnapshot(
  budget: bigint,
  snapshot: {
    complete: boolean;
    finalized: boolean;
    balances: { wallet: string; tokens: bigint }[];
    excluded: ReadonlySet<string>;
  }
) {
  if (!snapshot.complete || !snapshot.finalized)
    throw new Error('A complete finalized holder snapshot is required');
  if (budget < 0n) throw new Error('Invalid reward budget');
  const owners = new Map<string, bigint>();
  for (const { wallet, tokens } of snapshot.balances) {
    if (!wallet || tokens < 0n) throw new Error('Invalid holder balance');
    if (!snapshot.excluded.has(wallet)) owners.set(wallet, (owners.get(wallet) ?? 0n) + tokens);
  }
  const totalTokens = [...owners.values()].reduce((sum, value) => sum + value, 0n);
  const allocations = [...owners]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .flatMap(([wallet, tokens]) => {
      const lamports = totalTokens > 0n ? (budget * tokens) / totalTokens : 0n;
      return lamports > 0n ? [{ wallet, lamports }] : [];
    });
  const allocated = allocations.reduce((sum, item) => sum + item.lamports, 0n);
  return { allocations, carryForward: budget - allocated };
}
