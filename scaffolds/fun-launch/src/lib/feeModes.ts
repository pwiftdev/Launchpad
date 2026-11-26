// Launch fee policies. New coins use the single Masked mode; earlier modes stay for registered coins.
// One source for the launch form, rules page, fee badges, status API and config templates.
import modePolicy from '@/constants/modePolicy.json';

export type FeeModeId = keyof typeof modePolicy.modes;
export type QuoteId = keyof typeof modePolicy.quotes;
export type PayoutId = keyof typeof modePolicy.payouts;
export type Beneficiary = 'creator' | 'holders' | 'split';

export const FEE_MODE_IDS = Object.keys(modePolicy.modes) as FeeModeId[];
/** Retired hSOL-paired modes. Coins already launched with them keep their payouts. */
export const HSOL_MODES = ['mskd-hsol', 'hsol', 'cashback-hsol'] as const satisfies FeeModeId[];
export const isHsolMode = (mode: unknown): mode is (typeof HSOL_MODES)[number] =>
  HSOL_MODES.some((value) => value === mode);
export const DEFAULT_FEE_MODE: FeeModeId = 'masked';
/** The only mode new coins can launch with. Earlier modes remain readable for registered coins. */
export const LAUNCH_FEE_MODE = 'masked' as const satisfies FeeModeId;
export const isLaunchFeeMode = (value: unknown): value is typeof LAUNCH_FEE_MODE =>
  value === LAUNCH_FEE_MODE;

/** The creator's share of the 0.60%, in basis points of that share, chosen in 10% steps. */
export const CREATOR_SHARE_STEP_BPS = modePolicy.creatorShare.stepBps;
export const DEFAULT_CREATOR_SHARE_BPS = modePolicy.creatorShare.defaultBps;
export const isCreatorShareBps = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 10_000 &&
  value % CREATOR_SHARE_STEP_BPS === 0;
export const CREATOR_SHARE_OPTIONS = Array.from(
  { length: 10_000 / CREATOR_SHARE_STEP_BPS + 1 },
  (_, step) => step * CREATOR_SHARE_STEP_BPS
);
export const MODE_POLICY_VERSIONS = FEE_MODE_IDS.map((id) => modePolicy.modes[id].policyVersion);
export type ModePolicyVersion = `${FeeModeId}-v1`;

export const SCHEDULE = modePolicy.schedule;
export const SPLIT = modePolicy.split;
export const QUOTES = modePolicy.quotes;

export const quoteAsset = (mint?: string) => (mint === QUOTES.hsol.mint ? QUOTES.hsol : QUOTES.sol);

/** Percent strings: 125 -> "1.25%", 60 -> "0.60%", 9900 -> "99%" */
export const pct = (bps: number) =>
  `${bps % 100 === 0 ? String(bps / 100) : (bps / 100).toFixed(2)}%`;

export const isFeeModeId = (value: unknown): value is FeeModeId =>
  typeof value === 'string' && (FEE_MODE_IDS as string[]).includes(value);

export const isModePolicyVersion = (value: unknown): value is ModePolicyVersion =>
  typeof value === 'string' && (MODE_POLICY_VERSIONS as string[]).includes(value);

type Split = { meteoraBps: number; houseBps: number; buybackBps: number; beneficiaryBps: number };

/** Where each part of a mode's 1.25% goes, in bps of the trade. */
export function modeSplit(id: FeeModeId): Split {
  const mode = modePolicy.modes[id];
  return 'split' in mode ? mode.split : { ...SPLIT, buybackBps: 0 };
}

export function feeMode(id: FeeModeId) {
  const mode = modePolicy.modes[id];
  const quote = modePolicy.quotes[mode.quote as QuoteId];
  // A mode can pay its beneficiary in another asset than its pair (MSKD: SOL pair, Monero payouts)
  const payout = 'payout' in mode ? modePolicy.payouts[mode.payout as PayoutId] : null;
  return {
    id,
    ...mode,
    quote: mode.quote as QuoteId,
    beneficiary: mode.beneficiary as Beneficiary,
    quoteSymbol: quote.symbol,
    quoteDecimals: quote.decimals,
    bondingTarget: Number(quote.migrationQuoteThreshold) / 10 ** quote.decimals,
    split: modeSplit(id),
    /** Who receives the 0.60% */
    beneficiaryLabel:
      mode.beneficiary === 'creator'
        ? 'Creator'
        : mode.beneficiary === 'split'
          ? 'Creator and holders'
          : 'Holders',
    /** What that share is paid in */
    payoutSymbol: payout?.symbol ?? quote.symbol,
    /** Human name of the payout asset, e.g. "Monero" */
    payoutName: payout?.name ?? quote.symbol,
  };
}

export type FeeMode = ReturnType<typeof feeMode>;

export function feeModeByPolicy(policyVersion: string | null | undefined): FeeMode | null {
  const id = FEE_MODE_IDS.find((m) => modePolicy.modes[m].policyVersion === policyVersion);
  return id ? feeMode(id) : null;
}

export type SplitRow = {
  key: 'creator' | 'holders' | 'beneficiary' | 'house' | 'buyback' | 'meteora';
  label: string;
  bps: number;
};

/**
 * Rows for fee tables: where each part of every 1.25% goes. A Masked coin passes its locked
 * creator share; without one (the launch form before a choice) the 0.60% shows as one row.
 */
export function splitRows(mode: FeeMode, creatorShareBps?: number | null): SplitRow[] {
  const { split } = mode;
  const shared: SplitRow[] =
    mode.beneficiary === 'split' && isCreatorShareBps(creatorShareBps)
      ? [
          {
            key: 'creator',
            label: 'Creator',
            bps: (split.beneficiaryBps * creatorShareBps) / 10_000,
          },
          {
            key: 'holders',
            label: 'Holders',
            bps: (split.beneficiaryBps * (10_000 - creatorShareBps)) / 10_000,
          },
        ]
      : [{ key: 'beneficiary', label: mode.beneficiaryLabel, bps: split.beneficiaryBps }];
  return [
    ...shared,
    {
      key: 'house',
      label: mode.beneficiary === 'split' ? 'Masked treasury' : 'House',
      bps: split.houseBps,
    },
    ...(split.buybackBps
      ? [{ key: 'buyback' as const, label: '$MSKD buyback and burn', bps: split.buybackBps }]
      : []),
    { key: 'meteora', label: 'Meteora', bps: split.meteoraBps },
  ];
}

/** Shares of collected non-protocol income, in bps of 10,000. Integer for every policy. */
export function netShares(id: FeeModeId) {
  const split = modeSplit(id),
    net = split.beneficiaryBps + split.houseBps + split.buybackBps;
  const beneficiary = (split.beneficiaryBps * 10_000) / net,
    buyback = (split.buybackBps * 10_000) / net;
  if (!Number.isInteger(beneficiary) || !Number.isInteger(buyback))
    throw new Error('Fee split must divide collected income exactly');
  return { beneficiary, buyback };
}

/** Share of collected non-protocol income routed to a legacy mode's beneficiary, in bps of 10,000. */
export const BENEFICIARY_NET_BPS = Math.round(
  (SPLIT.beneficiaryBps / (SPLIT.beneficiaryBps + SPLIT.houseBps)) * 10_000
);

export function quoteMintFor(id: FeeModeId): string {
  return modePolicy.quotes[modePolicy.modes[id].quote as QuoteId].mint;
}

/** Mint the beneficiary share is paid in. Null when not configured (devnet without a mock). */
export function payoutMintFor(
  id: FeeModeId,
  network: 'mainnet-beta' | 'devnet' | 'localnet',
  env: Record<string, string | undefined> = {}
): string | null {
  const mode = modePolicy.modes[id];
  if (!('payout' in mode)) return quoteMintFor(id);
  const payout = modePolicy.payouts[mode.payout as PayoutId];
  if (network === 'mainnet-beta') return payout.mainnetMint;
  return env[payout.devnetMintEnv] || null;
}
