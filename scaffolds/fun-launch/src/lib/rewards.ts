export type ClaimAuthorization = {
  networkGenesis: string;
  mint: string;
  wallet: string;
  epoch: string | null;
  amount: string;
  requestId: string;
  issuedAt: number;
};
/** This message requests one server-paid transfer to the signing wallet. */
export function claimAuthorizationMessage(origin: string, input: ClaimAuthorization): string {
  return [
    `Request a SOL reward payout on ${origin}`,
    'Policy: rinsed-wallet-payout-v1',
    `Network genesis: ${input.networkGenesis}`,
    `Wallet: ${input.wallet}`,
    `Mint: ${input.mint}`,
    `Epoch: ${input.epoch ?? 'creator'}`,
    `Amount (lamports): ${input.amount}`,
    `Request: ${input.requestId}`,
    `Issued at: ${input.issuedAt}`,
    'Send this reward only to the wallet above. No transaction signature or token approval is requested.',
  ].join('\n');
}
export type RewardReceipt = {
  epoch: string;
  lamports: string;
  status: 'available' | 'pending' | 'paid';
  jobId: string | null;
  jobStatus?: string | null;
  signature: string | null;
};
export type RewardsView = {
  payoutMethod?: 'server-paid';
  request?: RewardPayout | null;
  networkGenesis?: string;
  status: 'ready' | 'unfunded' | 'unavailable';
  mode: import('@/lib/launchModes').LaunchMode | null;
  availableLamports: string;
  paidLamports?: string;
  creatorReceipts?: { lamports: string; signature: string; finalizedSlot: string }[];
  nextEpoch?: string | null;
  epochs: RewardReceipt[];
  creatorJob?: { id: string; signature: string | null; status?: string; amount?: string } | null;
};

export type RewardPayout = {
  id: string;
  status: string;
  signature: string | null;
  amount: string;
  requestId?: string;
};
