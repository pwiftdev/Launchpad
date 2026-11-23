import { database } from './database';

import type { LaunchMode, LaunchPolicyVersion } from '@/lib/launchModes';
export type { LaunchMode } from '@/lib/launchModes';
export type RegisteredConfig = {
  network_genesis: string;
  config_key: string;
  policy_version: LaunchPolicyVersion;
  expected_fee_claimer: string;
  expected_leftover_receiver: string;
  config_digest: string;
  enabled_for_launch: boolean;
  verified_slot: string;
};
export type RegisteredCoin = {
  network_genesis: string;
  mint: string;
  dbc_pool: string;
  config_key: string;
  original_deployer: string;
  mode: LaunchMode;
  recipient: string;
  policy_version: LaunchPolicyVersion;
  activation_point: string;
  /** Unix seconds; Bond it. activation_point itself is a slot. */
  activation_time?: string | null;
  creation_signature: string;
  finalized_slot: string;
};
export type LaunchIntent = {
  network_genesis: string;
  mint: string;
  config_key: string;
  deployer: string;
  mode: LaunchMode;
  payload_digest: string;
  prepared_slot: string;
  expires_at: Date;
  created_at: Date;
};

export async function registeredConfig(genesis: string, key: string) {
  if (!process.env.DATABASE_URL) return null;
  const result = await database().query<RegisteredConfig>(
    'SELECT * FROM launch_configs WHERE network_genesis=$1 AND config_key=$2',
    [genesis, key]
  );
  return result.rows[0] ?? null;
}
export async function registeredConfigKeys(
  genesis: string,
  policyVersion?: LaunchPolicyVersion
): Promise<string[]> {
  if (!process.env.DATABASE_URL) return [];
  const result = await database().query<{ config_key: string }>(
    `SELECT config_key FROM launch_configs WHERE network_genesis=$1${policyVersion ? ' AND policy_version=$2' : ''} ORDER BY config_key`,
    policyVersion ? [genesis, policyVersion] : [genesis]
  );
  return result.rows.map((row) => row.config_key);
}
export async function registeredCoin(genesis: string, mint: string) {
  if (!process.env.DATABASE_URL) return null;
  const result = await database().query<RegisteredCoin>(
    'SELECT * FROM launch_coins WHERE network_genesis=$1 AND mint=$2',
    [genesis, mint]
  );
  return result.rows[0] ?? null;
}
export async function launchIntent(genesis: string, mint: string) {
  const result = await database().query<LaunchIntent>(
    'SELECT * FROM pending_launch_intents WHERE network_genesis=$1 AND mint=$2',
    [genesis, mint]
  );
  return result.rows[0] ?? null;
}

/** Repeated preparation cannot change a mint's signed mode or deployer. */
export async function reserveLaunchIntent(input: {
  genesis: string;
  mint: string;
  configKey: string;
  deployer: string;
  mode: LaunchMode;
  payloadDigest: string;
  preparedSlot: number;
}) {
  if (!Number.isSafeInteger(input.preparedSlot) || input.preparedSlot <= 0)
    throw new Error('A finalized preparation slot is required');
  await database().query(
    `INSERT INTO pending_launch_intents(network_genesis,mint,config_key,deployer,mode,payload_digest,prepared_slot,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '15 minutes') ON CONFLICT(network_genesis,mint) DO NOTHING`,
    [
      input.genesis,
      input.mint,
      input.configKey,
      input.deployer,
      input.mode,
      input.payloadDigest,
      input.preparedSlot,
    ]
  );
  const saved = await launchIntent(input.genesis, input.mint);
  if (
    !saved ||
    saved.deployer !== input.deployer ||
    saved.mode !== input.mode ||
    saved.config_key !== input.configKey ||
    saved.payload_digest !== input.payloadDigest ||
    BigInt(saved.prepared_slot) <= 0n ||
    new Date(saved.expires_at).getTime() <= Date.now()
  )
    throw new Error('Launch intent conflicts or expired');
  return saved;
}

/** Only the finalized chain confirmation path calls this, never raw upload/metadata input. */
export async function recordFinalizedLaunch(coin: RegisteredCoin): Promise<RegisteredCoin> {
  await database().query(
    `INSERT INTO launch_coins(network_genesis,mint,dbc_pool,config_key,original_deployer,mode,recipient,
      policy_version,activation_point,creation_signature,finalized_slot,activation_time)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(network_genesis,mint) DO NOTHING`,
    [
      coin.network_genesis,
      coin.mint,
      coin.dbc_pool,
      coin.config_key,
      coin.original_deployer,
      coin.mode,
      coin.recipient,
      coin.policy_version,
      coin.activation_point,
      coin.creation_signature,
      coin.finalized_slot,
      coin.activation_time ?? null,
    ]
  );
  const saved = await registeredCoin(coin.network_genesis, coin.mint);
  if (
    !saved ||
    [
      'dbc_pool',
      'config_key',
      'original_deployer',
      'mode',
      'recipient',
      'policy_version',
      'activation_point',
      'creation_signature',
    ].some((key) => saved[key as keyof RegisteredCoin] !== coin[key as keyof RegisteredCoin])
  )
    throw new Error('Finalized launch conflicts with the immutable registry');
  return saved;
}
