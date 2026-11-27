import modePolicy from '@/constants/modePolicy.json';
import { formatTokenUnits } from './tokenUnits';

export type ClaimCurrency = 'xmr' | 'wxmr' | 'sol';
export type SolanaClaimCurrency = Exclude<ClaimCurrency, 'xmr'>;

export type CoinEarnings = {
  mint: string;
  creatorLamports: string;
  holderLamports: string;
  holderHours: number;
};

export type MaskedClaimView = {
  id: string;
  currency: ClaimCurrency;
  lamports: string;
  status: 'queued' | 'batched' | 'sent' | 'paid' | 'failed';
  xmrAtomic: string | null;
  createdAt: string;
  failure: string | null;
};

export type EarningsView = {
  networkGenesis: string;
  wallet: string;
  coins: CoinEarnings[];
  /** Earnings available for conversion to wXMR. */
  totalLamports: string;
  /** SOL pays per coin, and parts below the per-payout minimum wait for more income. */
  solClaimableLamports: string;
  minimumWxmrLamports: string;
  wxmrAvailable: boolean;
  openClaim: MaskedClaimView | null;
  history: MaskedClaimView[];
};

export type MaskedClaimRequest = {
  networkGenesis: string;
  wallet: string;
  currency: ClaimCurrency;
  /** Native XMR claims only. */
  moneroAddress?: string;
  lamports: string;
  requestId: string;
  issuedAt: number;
};

export const CURRENCY_LABEL: Record<ClaimCurrency, string> = {
  xmr: 'XMR (Monero)',
  wxmr: 'wXMR on Solana',
  sol: 'SOL',
};

export const formatWxmr = (units: string | bigint) =>
  `${formatTokenUnits(units, modePolicy.payouts.wxmr.decimals)} wXMR`;

/** The wallet signs this exact text. It authorizes one payout of exactly this amount. */
export function maskedClaimMessage(origin: string, input: MaskedClaimRequest): string {
  return [
    `Claim my Masked earnings on ${origin}`,
    `Wallet: ${input.wallet}`,
    `Network: ${input.networkGenesis}`,
    `Pay in: ${CURRENCY_LABEL[input.currency]}`,
    ...(input.currency === 'xmr' ? [`Monero address: ${input.moneroAddress ?? ''}`] : []),
    `Amount: ${input.lamports} lamports of earnings`,
    `Request: ${input.requestId}`,
    `Issued at: ${input.issuedAt}`,
    'This signature authorizes this one payout only. It cannot move any other funds.',
  ].join('\n');
}
