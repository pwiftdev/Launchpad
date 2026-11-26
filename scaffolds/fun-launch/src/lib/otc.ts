import { NETWORK_GENESIS } from '../../../../scripts/network-policy.cjs';
import { readPrivateInvite } from './privateInvite';
import { socialRequest, unlockPrivateSession } from './profiles';

export const OTC_API = '/api/otc';
export const OTC_WALLET_HEADER = 'X-OTC-Wallet';
export const OTC_ASSETS = ['SOL', 'USDC'] as const;
export const OTC_EXPIRIES = { 15: '15 minutes', 60: '1 hour', 1440: '24 hours' } as const;
/** Lamports each funding wallet sets aside for Rings network fees and rent; unused SOL is returned. */
export const OTC_FEE_RESERVE = 6_000_000;
export type OtcAsset = (typeof OTC_ASSETS)[number];
export type OtcExpiry = keyof typeof OTC_EXPIRIES;
export type OtcToken = {
  mint: string;
  symbol: string;
  decimals: number;
  program: 'spl' | 'token-2022';
};
export type OtcTokenPage = {
  tokens: Pick<OtcToken, 'mint' | 'symbol'>[];
  next: string | null;
};
export type OtcLeg =
  { asset: OtcAsset; amount: string } | { asset: 'TOKEN'; amount: string; token: OtcToken };
export type OtcTerms = { sell: OtcLeg; buy: OtcLeg };
export type OtcOffer = { terms: OtcTerms; expiresAt: string };
export type OwnedOtcOffer = OtcOffer & {
  id: string;
  viewerWallet: string | null;
  accepted: boolean;
};
export type ViewedOtcOffer = OtcOffer & {
  dealId?: string;
  expiresInMs: number;
  genesis: string;
  status: 'open' | 'maker' | 'accepted' | 'reserved';
  canAccept: boolean;
};

const decimals: Record<OtcAsset, number> = { SOL: 9, USDC: 6 };
const MAX_AMOUNT = 18_446_744_073_709_551_615n;

export const oppositeOtcAsset = (asset: OtcAsset): OtcAsset => (asset === 'SOL' ? 'USDC' : 'SOL');

function parseOtcAmount(asset: OtcAsset | OtcToken, value: string) {
  const text = value.trim();
  const match = /^(0|[1-9]\d{0,19})(?:\.(\d{1,9}))?$/.exec(text);
  if (!match) return null;
  const integer = match[1]!;
  const fraction = match[2] ?? '';
  const precision = typeof asset === 'string' ? decimals[asset] : asset.decimals;
  if (fraction.length > precision) return null;
  const units = BigInt(integer + fraction.padEnd(precision, '0'));
  if (units === 0n || units > MAX_AMOUNT) return null;
  const significantFraction = fraction.replace(/0+$/, '');
  return { units, amount: significantFraction ? `${integer}.${significantFraction}` : integer };
}

export const normalizeOtcAmount = (asset: OtcAsset | OtcToken, value: string) =>
  parseOtcAmount(asset, value)?.amount ?? null;
export const otcAmountUnits = (asset: OtcAsset | OtcToken, value: string) =>
  parseOtcAmount(asset, value)?.units ?? null;

export const readOtcInvite = () => readPrivateInvite('mskd.otc.');
export const otcLegAsset = (leg: OtcLeg) => (leg.asset === 'TOKEN' ? leg.token : leg.asset);
export const otcAssetLabel = (leg: OtcLeg) =>
  leg.asset === 'TOKEN' ? leg.token.symbol : leg.asset;
const signedAsset = (leg: OtcLeg) =>
  leg.asset === 'TOKEN' ? `${leg.token.symbol} (mint ${leg.token.mint})` : leg.asset;

export async function otcAcceptanceMessage(
  token: string,
  wallet: string,
  origin: string,
  genesis: string,
  { terms, expiresAt }: OtcOffer
) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const reference = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  return [
    genesis === NETWORK_GENESIS['mainnet-beta']
      ? 'MSKD.fun · Agree to off-chain OTC offer (v1)'
      : 'MSKD.fun · Agree to test OTC offer (v1)',
    `Site ${origin}`,
    `Network ${genesis}`,
    `Offer ${reference}`,
    `Wallet ${wallet}`,
    `You would send ${terms.buy.amount} ${signedAsset(terms.buy)}`,
    `You would receive ${terms.sell.amount} ${signedAsset(terms.sell)}`,
    `Expires ${expiresAt}`,
    'This signature records your agreement. It cannot move funds.',
  ].join('\n');
}

export function otcRequest<T>(body: object, wallet?: string, signal?: AbortSignal): Promise<T> {
  return socialRequest(OTC_API, body, wallet ? { [OTC_WALLET_HEADER]: wallet } : undefined, signal);
}

export function unlockOtc(
  wallet: string,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
  signal: AbortSignal
) {
  return unlockPrivateSession(OTC_API, 'otc', wallet, signMessage, signal);
}
