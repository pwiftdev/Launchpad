// The public proof page's data: what Masked earned, burned and paid each UTC day, what it holds
// against what it owes, and which keys control what. Totals only; no earner is listed.

export type ProofReceipt = { signature: string; at: string; lamports: string; tokens?: string };

export type ProofDay = {
  /** UTC date, YYYY-MM-DD. */
  day: string;
  feesCollectedLamports: string;
  collections: number;
  mskdBoughtLamports: string;
  mskdBurnedTokens: string;
  burns: number;
  solPaidLamports: string;
  wxmrPaidLamports: string;
  wxmrPaidAtomic: string;
  xmrPaidLamports: string;
  xmrPaidAtomic: string;
  xmrReceivedAtomic: string;
  /** Monero transaction hashes of the day's payout batches. */
  xmrTransactions: string[];
  /** Distinct wallets paid that day, in any currency. */
  peoplePaid: number;
};

export type ProofControl = {
  label: string;
  address: string;
  kind: 'solana' | 'monero';
  role: string;
};

export type ProofView = {
  networkGenesis: string;
  generatedAt: string;
  days: ProofDay[];
  recentCollections: ProofReceipt[];
  recentBurns: ProofReceipt[];
  /** Null when this server has no company wallets configured. */
  reserves: {
    collector: string;
    /** Fee income still held for payout, every share included. */
    heldLamports: string;
    balanceLamports: string | null;
    xmrUnlockedAtomic: string | null;
    xmrHeartbeatAt: string | null;
    xmrClaimsWaiting: number;
    xmrClaimsWaitingLamports: string;
  } | null;
  treasury: {
    address: string;
    viewKey: string;
    restoreHeight: string | null;
    verified: boolean;
    publishedAt: string;
    keyImages: { count: number; walletHeight: string; exportedAt: string; digest: string } | null;
  } | null;
  controls: ProofControl[];
};
