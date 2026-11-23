export type WhitelistInterest = 'trader' | 'creator' | 'both';
export type WhitelistReceipt = {
  wallet: string;
  registrationId: string;
  interest: WhitelistInterest;
  status: 'registered' | 'approved' | 'revoked';
  joinedAt: string;
  /** Shareable code for this wallet's referral link (/w/CODE) */
  referralCode: string;
  /** Wallets that joined through this wallet's link */
  referrals: number;
};

// No 0/O, 1/I/L: codes get read aloud and typed from screenshots
export const REFERRAL_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
// New codes are 8 chars from REFERRAL_ALPHABET; codes backfilled for earlier entries are 8 hex chars
export const REFERRAL_CODE = /^[A-Z0-9]{8}$/;

/** Uppercases and validates a referral code from a URL; null if it is not one. */
export function parseReferralCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return REFERRAL_CODE.test(code) ? code : null;
}

export function whitelistMessage({
  origin,
  wallet,
  interest,
  nonce,
  issuedAt,
  expiresAt,
  referralCode,
}: {
  origin: string;
  wallet: string;
  interest: WhitelistInterest;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  referralCode?: string | null;
}) {
  return [
    'plzzz.bond — Mainnet early access',
    `Website: ${origin}`,
    `Wallet: ${wallet}`,
    `Interest: ${interest}`,
    ...(referralCode ? [`Referred by code: ${referralCode}`] : []),
    'Purpose: Register this wallet for launchpad early access.',
    'Airdrop: Whitelisters will receive $PLZZZ. Successful referrals increase your allocation.',
    'This is a message signature only. No transaction, payment, token approval, or spending permission.',
    `Nonce: ${nonce}`,
    `Issued at: ${issuedAt}`,
    `Expires at: ${expiresAt}`,
    'Version: early-access-v1',
  ].join('\n');
}
