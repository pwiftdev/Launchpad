import { otcConfig } from './otcConfig';

export function otcRingsConfig() {
  const base = otcConfig();
  const enabled = process.env.OTC_RINGS_SETTLEMENT_ENABLED === 'true';
  if (!base || (!enabled && !process.env.OTC_RINGS_RPC_URL)) return null;
  const network = process.env.NEXT_PUBLIC_NETWORK;
  try {
    const rpc = new URL(process.env.OTC_RINGS_RPC_URL || process.env.RPC_URL || '');
    if (
      network === 'localnet' &&
      process.env.NODE_ENV !== 'production' &&
      rpc.protocol === 'http:' &&
      rpc.hostname === '127.0.0.1' &&
      rpc.pathname === '/' &&
      !rpc.search &&
      !rpc.hash &&
      !rpc.username &&
      !rpc.password
    ) {
      return { ...base, rpc, network, enabled } as const;
    }
    const host =
      network === 'mainnet-beta'
        ? 'mainnet.helius-rpc.com'
        : network === 'devnet'
          ? 'devnet.helius-rpc.com'
          : '';
    if (
      rpc.protocol !== 'https:' ||
      rpc.hostname !== host ||
      rpc.port ||
      rpc.pathname !== '/' ||
      rpc.hash ||
      rpc.username ||
      rpc.password ||
      [...rpc.searchParams.keys()].join() !== 'api-key' ||
      !rpc.searchParams.get('api-key')
    )
      return null;
    if (network === 'mainnet-beta' || network === 'devnet')
      return { ...base, rpc, network, enabled } as const;
  } catch {
    return null;
  }
  return null;
}

export type OtcRingsConfig = NonNullable<ReturnType<typeof otcRingsConfig>>;
