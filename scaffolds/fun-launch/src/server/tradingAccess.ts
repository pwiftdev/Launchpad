import type { NextApiResponse } from 'next';
import { connection, getLaunchConfig } from './dbc';
import { configuredCompanyWallets } from './launchConfig';
import type { LaunchMode } from './launchRegistry';
import { ACTIVE_LAUNCH_MODE, ACTIVE_LAUNCH_POLICY } from '@/lib/launchModes';
import {
  expectedNetworkGenesis,
  localValidatorPolicy,
  NETWORK_GENESIS,
} from '../../../../scripts/network-policy.cjs';

/** Live network, explicit release flag and reviewed wallet policy are all required. */
export async function verifiedTradingAccess(mode: LaunchMode = ACTIVE_LAUNCH_MODE) {
  if (mode !== ACTIVE_LAUNCH_MODE) throw new Error('Only Bond it. is available for new launches');
  const expected = expectedNetworkGenesis(process.env);
  const isolated = localValidatorPolicy(process.env);
  // Read the runtime environment object: Next inlines direct NEXT_PUBLIC_* references.
  const environment = process.env;
  const network = environment.NEXT_PUBLIC_NETWORK || 'devnet';
  if (
    (process.env.SOLANA_NETWORK && process.env.SOLANA_NETWORK !== network) ||
    (expected === NETWORK_GENESIS['mainnet-beta'] &&
      process.env.MAINNET_TRADING_ENABLED !== 'true') ||
    (!isolated &&
      expected !== NETWORK_GENESIS.devnet &&
      expected !== NETWORK_GENESIS['mainnet-beta'])
  )
    throw new Error('Financial network is not released');
  // Every financial mutation checks the live endpoint, including drift behind an unchanged URL.
  if ((await connection.getGenesisHash()) !== expected)
    throw new Error('RPC genesis differs from configured network');
  configuredCompanyWallets(expected);
  const approved = await getLaunchConfig(mode);
  if (
    approved.genesis !== expected ||
    approved.record?.policy_version !== ACTIVE_LAUNCH_POLICY ||
    !approved.record.enabled_for_launch
  )
    throw new Error('A reviewed enabled wallet policy is required');
  if ((await connection.getGenesisHash()) !== expected)
    throw new Error('Financial network changed');
  return approved;
}
export async function allowTrading(res: NextApiResponse): Promise<boolean> {
  try {
    await verifiedTradingAccess();
    return true;
  } catch {
    /* Missing flag, invalid local overrides, legacy policy and network drift all fail closed. */
  }
  res.status(503).json({
    error:
      'Trading is unavailable until this network and its reviewed wallet fee policy are enabled.',
  });
  return false;
}
