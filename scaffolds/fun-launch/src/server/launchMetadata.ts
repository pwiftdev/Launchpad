import { BRAND } from '@/constants/brand';
import { hasSocials, normalizeSocials, type Socials } from '@/lib/socials';

/** The token's off-chain metadata JSON; the on-chain Metaplex `uri` points here. */
export type LaunchMetadata = {
  name: string;
  symbol: string;
  image: string;
  mint: string;
  createdOn: string;
  source?: string;
  description?: string;
  // Project links: top-level for launchpad readers, `extensions` for explorers and DEX screeners.
  website?: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
  extensions?: Socials;
  /** Legacy metadata is descriptive only; economic authority comes from the verified registry. */
  creatorMode?: { burnShare: number };
  launchMode?: import('@/lib/launchModes').LaunchMode;
  /** Masked: the creator's locked share of the 0.60%. Descriptive; the registry is authoritative. */
  feeSplit?: { creatorShareBps: number };
};

export function buildLaunchMetadata(params: {
  tokenName: string;
  tokenSymbol: string;
  mint: string;
  image: string;
  source?: string;
  description?: string;
  socials?: Socials;
  burnShare: number;
  mode?: import('@/lib/launchModes').LaunchMode;
  creatorShareBps?: number;
}): LaunchMetadata {
  const socials = normalizeSocials(params.socials);
  return {
    name: params.tokenName,
    symbol: params.tokenSymbol,
    image: params.image,
    mint: params.mint,
    createdOn: BRAND.url,
    ...(params.description ? { description: params.description } : {}),
    ...(params.source ? { source: params.source } : {}),
    ...(hasSocials(socials) ? { ...socials, extensions: socials } : {}),
    ...(params.mode
      ? { launchMode: params.mode }
      : { creatorMode: { burnShare: params.burnShare } }),
    ...(params.creatorShareBps !== undefined
      ? { feeSplit: { creatorShareBps: params.creatorShareBps } }
      : {}),
  };
}
