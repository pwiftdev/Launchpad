import type { Connection } from '@solana/web3.js';
import { configuredCompanyWallets, expectedGenesis, NETWORK_GENESIS } from '../launchConfig';

/** The scheduler, signer and relay each enforce this independently before financial mutation. */
export async function assertWalletExecutionGate(
  rpc: Pick<Connection, 'getGenesisHash'>,
  genesis: string,
  options: { worker?: boolean } = {}
) {
  if (genesis !== expectedGenesis() || (await rpc.getGenesisHash()) !== genesis)
    throw new Error('Wallet execution network mismatch');
  const wallets = configuredCompanyWallets(genesis, { allowLegacy: true });
  if (options.worker && process.env.WALLET_WORKER_ENABLED !== 'true')
    throw new Error('Wallet worker is disabled');
  if (genesis === NETWORK_GENESIS['mainnet-beta'] && process.env.MAINNET_TRADING_ENABLED !== 'true')
    throw new Error('Mainnet financial execution is disabled');
  return wallets;
}
