import { createHash } from 'node:crypto';
import { PublicKey, type Connection } from '@solana/web3.js';
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  type PoolConfig,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { inspectLaunchConfig, reviewedQuote } from '../../../../scripts/launch-policy.cjs';
import { registeredConfig, registeredConfigKeys, type LaunchMode } from './launchRegistry';
import { vaultAddresses } from '@/lib/vault/client';
import {
  NETWORK_GENESIS,
  expectedNetworkGenesis,
  mainnetConfigPin,
  mainnetLaunchPolicy,
} from '../../../../scripts/network-policy.cjs';
import { companyWallets } from '../../../../scripts/company-wallets.cjs';
import { ACTIVE_LAUNCH_POLICY, isWalletPolicy } from '@/lib/launchModes';

import { FEE_MODE_IDS, feeModeByPolicy, isFeeModeId, isModePolicyVersion } from '@/lib/feeModes';

/** Explicit company wallets; legacy program IDs never supply new-launch fee authority. */
export function configuredCompanyWallets(
  genesis = expectedGenesis(),
  options: { allowLegacy?: boolean } = {}
): {
  collector: PublicKey;
  treasury: PublicKey;
} {
  return companyWallets(process.env, genesis, options);
}

export function configuredVaultProgram(): PublicKey {
  const key = process.env.VAULT_PROGRAM_ID;
  if (!key || key !== process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID)
    throw new Error('Matching custody program configuration is required');
  const program = new PublicKey(key);
  if (program.equals(PublicKey.default)) throw new Error('Invalid custody program');
  return program;
}

export function assertConfigApproval(data: Buffer, key: PublicKey, digest: string) {
  if (
    data.length !== 74 ||
    data.subarray(0, 8).toString('ascii') !== 'RCONF001' ||
    data[8] !== 1 ||
    !data.subarray(10, 42).equals(key.toBuffer()) ||
    data.subarray(42, 74).toString('hex') !== digest
  )
    throw new Error('Custody program config approval does not match the reviewed account');
}

export { NETWORK_GENESIS };

export function expectedGenesis() {
  return expectedNetworkGenesis(process.env);
}
export async function verifiedGenesis(connection: Pick<Connection, 'getGenesisHash'>) {
  const actual = await connection.getGenesisHash();
  if (actual !== expectedGenesis())
    throw new Error('RPC genesis does not match the configured network');
  return actual;
}

/** Public discovery includes only the current product's reviewed economic policy. */
export async function discoverableConfigKeys(genesis: string) {
  // Historical configs remain in the immutable registry for private settlement and auditing.
  // Neither an old active environment key nor LEGACY_POOL_CONFIG_KEYS makes them public again.
  const mainnet = genesis === NETWORK_GENESIS['mainnet-beta'];
  const primary = mainnet ? mainnetLaunchPolicy() : ACTIVE_LAUNCH_POLICY;
  const policies = [
    primary,
    ...FEE_MODE_IDS.map((id) => `${id}-v1` as const).filter(
      (policy) => policy !== primary && (!mainnet || mainnetConfigPin(policy))
    ),
  ];
  return [
    ...new Set(
      (
        await Promise.all(
          policies.map(async (policy) => {
            const keys = await registeredConfigKeys(genesis, policy);
            const pin = mainnet && policy !== primary ? mainnetConfigPin(policy) : null;
            return pin ? keys.filter((key) => key === pin) : keys;
          })
        )
      ).flat()
    ),
  ];
}

export async function verifyConfigAccount(
  connection: Pick<Connection, 'getAccountInfo'>,
  key: PublicKey
) {
  const account = await connection.getAccountInfo(key, 'finalized');
  if (!account || !account.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID))
    throw new Error('Expected a DBC-owned configuration');
  return createHash('sha256').update(account.data).digest('hex');
}

/** New modes require a reviewed, enabled immutable registry entry before any upload spending. */
export async function verifyLaunchConfig(
  genesis: string,
  key: PublicKey,
  config: PoolConfig,
  digest: string,
  mode?: LaunchMode,
  options: { allowDisabled?: boolean; allowLegacy?: boolean } = {}
) {
  const record = await registeredConfig(genesis, key.toBase58());
  if (
    !record ||
    (feeModeByPolicy(record.policy_version)?.quote === 'hsol' &&
      genesis !== NETWORK_GENESIS['mainnet-beta']) ||
    (isModePolicyVersion(record.policy_version) &&
      genesis === NETWORK_GENESIS['mainnet-beta'] &&
      key.toBase58() !== mainnetConfigPin(record.policy_version)) ||
    (!record.enabled_for_launch && !options.allowDisabled) ||
    (record.policy_version !== ACTIVE_LAUNCH_POLICY &&
      !isModePolicyVersion(record.policy_version) &&
      !(options.allowLegacy && ['rinse-v1', 'wallet-v1'].includes(record.policy_version)))
  )
    throw new Error('A reviewed launch configuration is required for this mode');
  if (
    !mode ||
    (isFeeModeId(mode) || mode === 'bond'
      ? record.policy_version !== `${mode}-v1`
      : isModePolicyVersion(record.policy_version) || record.policy_version === 'bond-v1')
  )
    throw new Error('Launch mode differs from the reviewed economic policy');
  if (record.config_digest !== digest)
    throw new Error('Configuration differs from its reviewed record');
  if (isWalletPolicy(record.policy_version)) {
    const historical = options.allowLegacy === true && record.policy_version === 'wallet-v1';
    const wallets = historical
      ? companyWallets(
          {
            FEE_COLLECTOR_PUBLIC_KEY: record.expected_fee_claimer,
            TREASURY_PUBLIC_KEY: record.expected_leftover_receiver,
          },
          genesis,
          { allowLegacy: true }
        )
      : configuredCompanyWallets(genesis);
    if (
      record.expected_fee_claimer !== wallets.collector.toBase58() ||
      record.expected_leftover_receiver !== wallets.treasury.toBase58() ||
      !config.feeClaimer.equals(wallets.collector) ||
      !config.leftoverReceiver.equals(wallets.treasury)
    )
      throw new Error('Configuration differs from immutable company wallet destinations');
  } else {
    const feeAuthority = vaultAddresses(configuredVaultProgram(), PublicKey.default).feeAuthority;
    if (!config.feeClaimer.equals(feeAuthority))
      throw new Error('Legacy fee authority must be the custody program PDA');
  }
  const quote = reviewedQuote(record.policy_version);
  if (isModePolicyVersion(record.policy_version) && record.quote_mint !== quote.quoteMint)
    throw new Error('Registry quote mint differs from the reviewed policy');
  const issues = inspectLaunchConfig(config, {
    feeClaimer: record.expected_fee_claimer,
    leftoverReceiver: record.expected_leftover_receiver,
    policyVersion: record.policy_version,
    ...quote,
  });
  if (issues.length) throw new Error('Configuration does not match the release policy');
  // All economics rely on timestamp boundaries and permanently locked fee rights.
  if (
    config.activationType !==
      (record.policy_version === 'bond-v1' || isModePolicyVersion(record.policy_version) ? 0 : 1) ||
    config.collectFeeMode !== 0 ||
    config.creatorTradingFeePercentage !== 0
  )
    throw new Error('Unsupported fee authority or activation policy');
  if (
    config.partnerLiquidityPercentage !== 0 ||
    config.creatorLiquidityPercentage !== 0 ||
    config.partnerPermanentLockedLiquidityPercentage !== 100 ||
    config.creatorPermanentLockedLiquidityPercentage !== 0
  )
    throw new Error('Release policy requires all migration liquidity to remain permanently locked');
  return record;
}
