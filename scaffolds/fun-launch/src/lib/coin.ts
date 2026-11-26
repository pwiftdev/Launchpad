// Shapes returned by our /api/coins routes (read straight from the DBC program).
import type { PotSummary } from './pot';
import type { Socials } from './socials';

export type Coin = {
  /** Clearly marked visual fixtures. These IDs never represent a tradable mint. */
  isDemo?: boolean;
  description?: string;
  source?: string;
  /** Project links from the token metadata JSON, validated per kind. */
  socials?: Socials;
  mint: string;
  pool: string;
  creator: string;
  originalDeployer?: string;
  mode?: import('@/lib/launchModes').LaunchMode;
  configKey?: string;
  quoteMint?: string;
  quoteToSol?: number;
  /** Only immutable reviewed policy records authorize the current schedule display. */
  feePolicyVersion?: import('@/lib/launchModes').LaunchPolicyVersion;
  /** Masked: the creator's locked share of the 0.60%, in bps of that share. */
  creatorShareBps?: number | null;
  tokenDecimals?: number;
  tokenSupply?: number;
  migratedPool?: string;
  /** Current quote reserves in the graduated pool, converted to SOL. */
  migratedQuoteReserveSol?: number;
  /** Verified token order in the canonical graduated pool. */
  migratedBaseIsA?: boolean;
  dbcCollectFeeMode?: number;
  name: string;
  symbol: string;
  image: string | null;
  /** Pool activation time, unix seconds */
  launchedAt: number;
  /** Slot-based launch protection uses this value, not a seconds countdown. */
  launchSlot?: number;
  quoteReserveSol: number;
  thresholdSol: number;
  /** 0..1 progress toward the migration threshold */
  progress: number;
  isMigrated: boolean;
  priceSol: number;
  marketCapSol: number;
};

export type CoinsResponse = {
  /** Zero with clockStale means the display clock is unknown, not chain time. */
  serverTime: number;
  coins: Coin[];
  /** Coin data freshness, independent of clockStale. */
  stale?: boolean;
  clockStale?: boolean;
  updatedAt?: number;
};

/** A wallet's SOL and token balance, for trade presets. */
export type BalanceResponse = { sol: number; tokens: number; quoteBalance?: number };

export type CoinResponse = {
  serverTime: number;
  coin: Coin;
};

export type Holder = {
  owner: string;
  amount: number;
  /** Share of the supply held outside the bonding curve, 0..1 */
  shareOfCirculating: number;
  shareOfSupply?: number;
  isCreator: boolean;
};

export type HoldersResponse = {
  holders: Holder[];
  circulating: number;
  tokenSupply?: number;
  excludedSupply?: number;
  scope?: 'largest-token-accounts';
  sampledAccounts?: number;
  partial?: boolean;
  snapshotSlot?: number;
  updatedAt?: number;
  stale?: boolean;
};

export type Trade = {
  sig: string;
  /** Stable swap-invocation identity; several swaps can share one transaction signature. */
  id?: string;
  instructionIndex?: number;
  eventIndex?: number;
  /** unix seconds */
  ts: number;
  side: 'buy' | 'sell';
  wallet: string;
  walletRole?: 'token-owner' | 'swap-authority';
  /** SOL paid (buys, fee included) or received (sells, after fee) */
  sol: number;
  tokens: number;
  feeSol: number;
  feeSolIsEstimate?: boolean;
  route?: 'dbc' | 'damm-v2';
  /** Price after the trade, SOL per token */
  priceSol: number;
  marketCapSol: number;
};

export type TradesResponse = {
  /** Most recent trades, newest first */
  trades: Trade[];
  /** Price at launch, for the first candle */
  launchPriceSol: number;
  quoteToSol?: number;
  /** Holder pot and launch-tax totals over the coin's full history */
  pot: PotSummary;
  /** False if history was too long to read in full, so totals may be understated */
  complete: boolean;
  updatedAt?: number;
  stale?: boolean;
  pendingCount?: number;
};

export type TrendingCoin = Coin & { txLastHour: number };

export type TrendingResponse = {
  /** Zero with clockStale=true means no recent verified clock; never synchronize timers from it. */
  serverTime: number;
  runners: Coin[];
  trending: TrendingCoin[];
  updatedAt?: number;
  /** Ranking data freshness, independent of clockStale. */
  stale?: boolean;
  clockStale?: boolean;
  partial?: boolean;
  unavailableScores?: number;
  /** Counts cover at most 100 recent signatures per pool, not a complete hourly index. */
  transactionSampleLimit?: number;
};

export type QuoteResponse = {
  route?: 'dbc' | 'damm-v2';
  pool: string;
  feeMint?: string;
  feeAmount?: number;
  feeSolIsEstimate?: boolean;
  side: 'buy' | 'sell';
  amountIn: number;
  amountOut: number;
  minimumAmountOut: string;
  feeSol: number;
  feePercent: number;
  taxPercent: number;
};
