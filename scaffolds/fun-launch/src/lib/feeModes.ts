// The three MSKD launch modes and the flat 1.25% fee split they share.
// One source for the launch form, rules page, fee badges, status API and config templates.
import modePolicy from '@/constants/modePolicy.json';

export type FeeModeId = keyof typeof modePolicy.modes;
export type QuoteId = keyof typeof modePolicy.quotes;
export type PayoutId = keyof typeof modePolicy.payouts;
export type Beneficiary = 'creator' | 'holders';

export const FEE_MODE_IDS = Object.keys(modePolicy.modes) as FeeModeId[];
export const DEFAULT_FEE_MODE: FeeModeId = 'mskd';
export const MODE_POLICY_VERSIONS = FEE_MODE_IDS.map((id) => modePolicy.modes[id].policyVersion);
export type ModePolicyVersion = `${FeeModeId}-v1`;

export const SCHEDULE = modePolicy.schedule;
export const SPLIT = modePolicy.split;

/** Percent strings: 125 -> "1.25%", 60 -> "0.60%", 9900 -> "99%" */
export const pct = (bps: number) =>
  `${bps % 100 === 0 ? String(bps / 100) : (bps / 100).toFixed(2)}%`;

export const isFeeModeId = (value: unknown): value is FeeModeId =>
  typeof value === 'string' && (FEE_MODE_IDS as string[]).includes(value);

export const isModePolicyVersion = (value: unknown): value is ModePolicyVersion =>
  typeof value === 'string' && (MODE_POLICY_VERSIONS as string[]).includes(value);

export function feeMode(id: FeeModeId) {
  const mode = modePolicy.modes[id];
  const quote = modePolicy.quotes[mode.quote as QuoteId];
  // A mode can pay its beneficiary in another asset than its pair (MSKD: SOL pair, Monero payouts)
  const payout = 'payout' in mode ? modePolicy.payouts[mode.payout as PayoutId] : null;
  return {
    id,
    ...mode,
    beneficiary: mode.beneficiary as Beneficiary,
    quoteSymbol: quote.symbol,
    quoteDecimals: quote.decimals,
    /** Who receives the 0.60% */
    beneficiaryLabel: mode.beneficiary === 'creator' ? 'Creator' : 'Holders',
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

/** Rows for fee tables: where each part of every 1.25% goes. */
export function splitRows(mode: FeeMode) {
  return [
    { key: 'beneficiary', label: mode.beneficiaryLabel, bps: SPLIT.beneficiaryBps },
    { key: 'house', label: 'House', bps: SPLIT.houseBps },
    { key: 'meteora', label: 'Meteora', bps: SPLIT.meteoraBps },
  ] as const;
}

/** Share of collected non-protocol income routed to the mode's beneficiary, in bps of 10,000. */
export const BENEFICIARY_NET_BPS = Math.round(
  (SPLIT.beneficiaryBps / (SPLIT.beneficiaryBps + SPLIT.houseBps)) * 10_000
);

/** The quote mint a mode pairs against. Every mode pairs to SOL. */
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
