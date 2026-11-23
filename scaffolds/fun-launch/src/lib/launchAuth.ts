import { hasSocials, normalizeSocials, type Socials } from './socials';

export type LaunchPayload = {
  tokenLogo: string;
  tokenName: string;
  tokenSymbol: string;
  mint: string;
  userWallet: string;
  devBuyPercent: number;
  sourceUrl?: string;
  description?: string;
  /** Project links written into the token metadata JSON. */
  socials?: Socials;
  burnShare: number;
  mode?: 'bond' | 'creator' | 'community';
};

/** Same ordered payload in the browser and server; every upload field is signed. */
export async function launchPayloadDigest(payload: LaunchPayload): Promise<string> {
  const content = JSON.stringify([
    payload.tokenLogo,
    payload.tokenName,
    payload.tokenSymbol,
    payload.mint,
    payload.userWallet,
    payload.devBuyPercent,
    payload.sourceUrl ?? '',
    payload.burnShare,
    // Keep only legacy devnet messages byte-compatible; new modes are always signed explicitly.
    ...(payload.mode ? [payload.mode] : []),
    // Preserve existing authorizations without a description. New copy is signed in full.
    ...(payload.description ? [{ description: payload.description }] : []),
    // Links are signed in canonical form and key order, and only when present.
    ...(hasSocials(payload.socials) ? [{ socials: normalizeSocials(payload.socials) }] : []),
  ]);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}
export async function launchMessage(
  payload: LaunchPayload,
  origin: string,
  issuedAt: number
): Promise<string> {
  const digest = await launchPayloadDigest(payload);
  return `Authorize a token launch on ${origin}\nWallet: ${payload.userWallet}\nMint: ${payload.mint}\nIssued at: ${issuedAt}\n${payload.mode ? `Launch mode: ${payload.mode === 'bond' ? 'Bond it.' : payload.mode === 'creator' ? 'Creator Fees' : 'Community'}\n` : ''}Payload SHA-256: ${digest}\nThis signature authorizes metadata upload only.`;
}
