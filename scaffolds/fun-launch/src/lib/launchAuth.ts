import { hasSocials, normalizeSocials, type Socials } from './socials';

import { isFeeModeId, isLaunchFeeMode, pct, SPLIT } from './feeModes';

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
  configKey?: string;
  mode?: import('@/lib/launchModes').LaunchMode;
  /** Masked only: the creator's share of the 0.60%, in bps of that share. Locked at launch. */
  creatorShareBps?: number;
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
    ...(isLaunchFeeMode(payload.mode)
      ? [{ version: 3, configKey: payload.configKey, creatorShareBps: payload.creatorShareBps }]
      : isFeeModeId(payload.mode)
        ? [{ version: 2, configKey: payload.configKey }]
        : []),
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
  if (isLaunchFeeMode(payload.mode)) {
    if (!payload.configKey) throw new Error('A reviewed configuration is required');
    if (payload.creatorShareBps === undefined) throw new Error('Choose the creator share first');
    const creator = payload.creatorShareBps / 100;
    return `Authorize a token launch (v3) on ${origin}\nWallet: ${payload.userWallet}\nMint: ${payload.mint}\nLaunch mode: Masked\nFee split of the ${pct(SPLIT.beneficiaryBps)}: creator ${creator}%, holders ${100 - creator}%. Locked forever.\nConfiguration: ${payload.configKey}\nIssued at: ${issuedAt}\nPayload SHA-256: ${digest}\nThis signature authorizes metadata upload only.`;
  }
  if (isFeeModeId(payload.mode)) {
    if (!payload.configKey) throw new Error('A reviewed configuration is required');
    return `Authorize a token launch (v2) on ${origin}\nWallet: ${payload.userWallet}\nMint: ${payload.mint}\nLaunch mode: ${payload.mode}\nConfiguration: ${payload.configKey}\nIssued at: ${issuedAt}\nPayload SHA-256: ${digest}\nThis signature authorizes metadata upload only.`;
  }
  return `Authorize a token launch on ${origin}\nWallet: ${payload.userWallet}\nMint: ${payload.mint}\nIssued at: ${issuedAt}\n${payload.mode ? `Launch mode: ${payload.mode === 'bond' ? 'Bond it.' : payload.mode === 'creator' ? 'Creator Fees' : 'Community'}\n` : ''}Payload SHA-256: ${digest}\nThis signature authorizes metadata upload only.`;
}
