// Server-only accounting for the upcoming policy. These are accrued budgets, never proof of funding.
import {
  BENEFICIARY_NET_BPS,
  feeMode,
  isCreatorShareBps,
  isFeeModeId,
  netShares,
} from '@/lib/feeModes';
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
  /** $MSKD buyback and burn share. Masked coins only. */
  mskdBuyback: bigint;
};

/** Cumulative carry: the same total always allocates the same amount, however it is batched. */
const carried = (previous: bigint, available: bigint, bps: bigint) =>
  ((previous + available) * bps) / 10_000n - (previous * bps) / 10_000n;

function cumulativeMaskedShares(
  net: bigint,
  beneficiaryBps: bigint,
  buybackBps: bigint,
  creatorBps: bigint
) {
  const mskdBuyback = (net * buybackBps) / 10_000n;
  const remaining = net - mskdBuyback;
  const beneficiary = (remaining * beneficiaryBps) / (10_000n - buybackBps);
  const creator = (beneficiary * creatorBps) / 10_000n;
  return {
    creator,
    community: beneficiary - creator,
    platform: remaining - beneficiary,
    mskdBuyback,
  };
}

export function allocateExecutedFee({
  total,
  protocol,
  referral = 0n,
  activationTime,
  tradeTime,
  mode,
  previousPhaseNet = 0n,
  phase,
  creatorShareBps,
}: {
  total: bigint;
  protocol: bigint;
  referral?: bigint;
  activationTime: number;
  tradeTime: number;
  mode: LaunchMode;
  previousPhaseNet?: bigint;
  phase?: 'rinse' | 'post';
  /** The coin's locked creator share of the 0.60%, required for Masked coins only. */
  creatorShareBps?: number | null;
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
  if (isFeeModeId(mode) && feeMode(mode).beneficiary === 'split') {
    if (!isCreatorShareBps(creatorShareBps))
      throw new Error('A Masked coin requires its locked creator share');
    const shares = netShares(mode);
    const weights = [
      BigInt(shares.beneficiary),
      BigInt(shares.buyback),
      BigInt(creatorShareBps),
    ] as const;
    // Split each remainder in turn so rounding never makes a cumulative share decrease.
    const before = cumulativeMaskedShares(previousPhaseNet, ...weights);
    const after = cumulativeMaskedShares(previousPhaseNet + available, ...weights);
    return {
      protocol,
      referral,
      rinseBuyback: 0n,
      creator: after.creator - before.creator,
      community: after.community - before.community,
      platform: after.platform - before.platform,
      mskdBuyback: after.mskdBuyback - before.mskdBuyback,
    };
  }
  if (creatorShareBps !== undefined && creatorShareBps !== null)
    throw new Error('Only Masked coins carry a creator share');
  if (isFeeModeId(mode)) {
    const paysCreator = feeMode(mode).beneficiary === 'creator';
    const beneficiary = carried(previousPhaseNet, available, BigInt(BENEFICIARY_NET_BPS));
    return {
      protocol,
      referral,
      rinseBuyback: 0n,
      creator: paysCreator ? beneficiary : 0n,
      community: paysCreator ? 0n : beneficiary,
      platform: available - beneficiary,
      mskdBuyback: 0n,
    };
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
    mskdBuyback: 0n,
  };
}

type HolderBalances = {
  complete: boolean;
  finalized: boolean;
  balances: { wallet: string; tokens: bigint }[];
  excluded: ReadonlySet<string>;
};

export function eligibleHolderBalances(snapshot: HolderBalances) {
  if (!snapshot.complete || !snapshot.finalized)
    throw new Error('A complete finalized holder snapshot is required');
  const owners = new Map<string, bigint>();
  for (const { wallet, tokens } of snapshot.balances) {
    if (!wallet || tokens < 0n) throw new Error('Invalid holder balance');
    if (tokens > 0n && !snapshot.excluded.has(wallet))
      owners.set(wallet, (owners.get(wallet) ?? 0n) + tokens);
  }
  return owners;
}

export function allocateHolderSnapshot(budget: bigint, snapshot: HolderBalances) {
  if (budget < 0n) throw new Error('Invalid reward budget');
  const owners = eligibleHolderBalances(snapshot);
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

export type HolderSample = {
  balances: { wallet: string; tokens: bigint }[];
  excluded: ReadonlySet<string>;
};

/**
 * Time-weighted holder balances: each wallet's average over evenly spaced samples, so a wallet
 * that buys just before an epoch closes earns only for the samples it actually held through.
 * Wallets excluded in any sample stay excluded.
 */
export function timeWeightedBalances(samples: HolderSample[]) {
  if (!samples.length) throw new Error('At least one holder sample is required');
  const excluded = new Set<string>();
  for (const sample of samples) for (const owner of sample.excluded) excluded.add(owner);
  const totals = new Map<string, bigint>();
  for (const sample of samples)
    for (const { wallet, tokens } of sample.balances) {
      if (!wallet || tokens < 0n) throw new Error('Invalid holder balance');
      totals.set(wallet, (totals.get(wallet) ?? 0n) + tokens);
    }
  const count = BigInt(samples.length);
  return {
    complete: true as const,
    finalized: true as const,
    excluded,
    balances: [...totals]
      .map(([wallet, tokens]) => ({ wallet, tokens: tokens / count }))
      .filter((row) => row.tokens > 0n),
  };
}
