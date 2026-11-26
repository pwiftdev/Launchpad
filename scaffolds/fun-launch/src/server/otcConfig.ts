import { privateKey } from './privateEncryption';

export function otcConfig() {
  const network = process.env.NEXT_PUBLIC_NETWORK;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;

  const secret = privateKey(process.env.OTC_PREVIEW_SECRET);
  if (!secret) return null;
  if (network === 'devnet' || network === 'localnet') return { mode: 'test', secret } as const;
  if (
    network === 'mainnet-beta' &&
    process.env.OTC_MAINNET_OFFERS_ENABLED === 'true' &&
    /^postgres(?:ql)?:\/\//.test(databaseUrl)
  ) {
    return { mode: 'mainnet', secret } as const;
  }
  return null;
}
