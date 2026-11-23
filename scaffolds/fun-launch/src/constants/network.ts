// Which Solana cluster the app talks to. Defaults to devnet until we go mainnet.
export const NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? 'devnet') as
  'devnet' | 'mainnet-beta' | 'localnet';
export const WALLET_NETWORK = NETWORK === 'localnet' ? 'devnet' : NETWORK;
export const NETWORK_LABEL =
  NETWORK === 'localnet' ? 'Local validator' : NETWORK === 'devnet' ? 'Devnet' : 'Mainnet';

export const explorerUrl = (path: `tx/${string}` | `address/${string}` | `token/${string}`) =>
  NETWORK === 'localnet'
    ? `https://explorer.solana.com/${path}?cluster=custom&customUrl=${encodeURIComponent(process.env.NEXT_PUBLIC_LOCAL_VALIDATOR_RPC_URL || 'http://127.0.0.1:8899')}`
    : `https://solscan.io/${path}${NETWORK === 'devnet' ? '?cluster=devnet' : ''}`;
