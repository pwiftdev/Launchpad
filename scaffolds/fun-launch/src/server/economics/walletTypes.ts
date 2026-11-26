import type { RegisteredCoin } from '../launchRegistry';
import type { FinalizedEvidence } from './chainEvidence';
export type WalletBucket = 'rinse_buyback' | 'creator' | 'community' | 'platform';
export type WalletJobKind =
  | 'collect'
  | 'buyback'
  | 'creator_claim'
  | 'community_claim'
  | 'platform_claim'
  | 'setup'
  | 'holder_conversion';
export type WalletJobStatus =
  'queued' | 'prepared' | 'signed' | 'submitted' | 'manual_review' | 'finalized' | 'failed';
export type WalletEventId = { signature: string; instructionIndex: number; eventIndex: number };
export type WalletFeeObservation = {
  id: WalletEventId;
  pool: string;
  slot: number;
  phase: 0 | 1;
  net: bigint;
  eventDigest: string;
};
export type WalletExpectations = {
  collector: string;
  pool: string;
  route?: 'dbc' | 'damm-v2';
  sourceQuoteVault?: string;
  quoteAta?: string;
  tokenAta?: string;
  expectedLamports?: string;
  maximumSpendLamports?: string;
  burnTokens?: string;
  recipient?: string;
  preQuoteLamports?: string;
  newTokenAccountRent?: string;
  [key: string]: unknown;
};
export type PreparedWalletExecution = {
  networkGenesis: string;
  mint: string;
  kind: WalletJobKind;
  transactionBase64: string;
  messageDigest: string;
  preparedSlot: number;
  lastValidBlockHeight: number;
  expectations: WalletExpectations;
};
export type WalletJob = {
  id: string;
  network_genesis: string;
  mint: string;
  kind: WalletJobKind;
  intent_key: string;
  bucket: WalletBucket | null;
  recipient: string | null;
  epoch: string | null;
  lamports: string;
  status: WalletJobStatus;
  transaction_base64: string | null;
  message_digest: string | null;
  prepared_slot: string | null;
  last_valid_block_height: string | null;
  signature: string | null;
  finalized_slot: string | null;
  received_lamports: string;
  burned_tokens: string;
  expectations: WalletExpectations;
  details: Record<string, unknown>;
};
/** Parent's walletEvidence verifier brands this shape only after independent finalized receipt checks. */
export type WalletEffectFacts = {
  kind: WalletJobKind;
  networkGenesis: string;
  mint: string;
  signature: string;
  slot: number;
  transactionIndex: number;
  messageDigest: string;
  receivedLamports?: bigint;
  burnedTokens?: bigint;
  collectorDebitLamports?: bigint;
  recipient?: string;
  paidLamports?: bigint;
  receivedPayoutUnits?: bigint;
  operatingCostLamports?: bigint;
  /** Canonical same-slot ordering, needed to distinguish trades after a claim-all collection. */
  slotSignatures?: readonly string[];
  evidence: FinalizedEvidence;
};
export type WalletChainAdapter = {
  prepareCollection(input: {
    coin: RegisteredCoin;
    events: WalletFeeObservation[];
    maximumQuoteLamports: bigint;
  }): Promise<PreparedWalletExecution>;
  prepareBuyback(input: {
    coin: RegisteredCoin;
    maximumSpendLamports: bigint;
  }): Promise<PreparedWalletExecution>;
  preparePayout(job: WalletJob): Promise<PreparedWalletExecution>;
  prepareHolderConversion?(
    job: WalletJob,
    existing?: WalletExpectations
  ): Promise<PreparedWalletExecution>;
  prepareSetup(input: { coin: RegisteredCoin }): Promise<PreparedWalletExecution>;
  verifyFinalized(job: WalletJob, evidence: FinalizedEvidence): Promise<WalletEffectFacts>;
};
export type WalletSigner = {
  sign(job: WalletJob): Promise<{ signedTransactionBase64: string; signature: string }>;
};
export type WalletBalance = {
  bucket: WalletBucket;
  funded: string;
  reserved: string;
  spent: string;
  available: string;
};
