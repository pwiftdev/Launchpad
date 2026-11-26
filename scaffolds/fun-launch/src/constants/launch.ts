// Launch rules shared by the launch form, the create API and the fairness checks.
import launchPolicy from './launchPolicy.json';

export const TOTAL_SUPPLY = 1_000_000_000;
export const TOKEN_DECIMALS = 6;
export const TICKER_CHARACTERS = /[\p{L}\p{N}]/u;
export const LAUNCH_IMAGE_MAX_MB = 5;
export const LAUNCH_IMAGE_MAX_BYTES = LAUNCH_IMAGE_MAX_MB * 1024 * 1024;
export const LAUNCH_IMAGE_MAX_DATA_URL_LENGTH =
  'data:image/jpeg;base64,'.length + 4 * Math.ceil(LAUNCH_IMAGE_MAX_BYTES / 3);

// Optional dev first buy, paid by the dev, in the same transaction as the create.
// Our config sets enableFirstSwapWithMinFee, so this buy pays the 1.25% floor fee.
export const DEV_BUY_MAX_PERCENT_OF_SUPPLY = 2;
export const DEV_BUY_MAX_TOKENS = (TOTAL_SUPPLY * DEV_BUY_MAX_PERCENT_OF_SUPPLY) / 100;

// Preview concentration indicator only; this does not enforce cluster limits or withhold fees.
export const DEV_CLUSTER_MAX_PERCENT_OF_SUPPLY = 2;

// Launch tax: 90% decaying every 3s toward the nominal 1.25% target at 27s, then flat.
// Mirrors the on-chain exponential scheduler: cliff 90%, reduction factor 3782 bps, 9 periods of 3s.
export const LAUNCH_TAX_CLIFF_PERCENT = launchPolicy.startingFeeBps / 100;
export const LAUNCH_TAX_REDUCTION_BPS = launchPolicy.reductionBps;
export const LAUNCH_TAX_PERIODS = launchPolicy.periods;
export const LAUNCH_TAX_STEP_SECONDS = launchPolicy.stepSeconds;
export const LAUNCH_TAX_WINDOW_SECONDS = LAUNCH_TAX_PERIODS * LAUNCH_TAX_STEP_SECONDS;
export const BASE_FEE_PERCENT = launchPolicy.endingFeeBps / 100;

// Legacy devnet history estimate only. Actual mainnet routing belongs to the server fee ledger.
export const LEGACY_POT_ESTIMATE_SHARE = 0.8;

// Bonding target. There is no deadline-based holder settlement in the current policy.
export const MIGRATION_THRESHOLD_SOL = 80;
