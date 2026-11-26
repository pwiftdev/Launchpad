import fs from 'node:fs';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { companyWallets } from '../../../../../scripts/company-wallets.cjs';
import { expectedNetworkGenesis, NETWORK_GENESIS } from '../../../../../scripts/network-policy.cjs';
import type { WalletSigningLimits } from './walletSigner';

export const WALLET_SIGNER_ENVIRONMENT = [
  'RPC_URL',
  'DATABASE_URL',
  'DATABASE_SSL_CA',
  'NEXT_PUBLIC_NETWORK',
  'FEE_COLLECTOR_PUBLIC_KEY',
  'TREASURY_PUBLIC_KEY',
  'LAUNCH_POLICY_VERSION',
  'POOL_CONFIG_KEY',
  'MAINNET_CASHBACK_CONFIG_KEY',
  'MAINNET_MSKD_CONFIG_KEY',
  'MAINNET_HSOL_CONFIG_KEY',
  'MAINNET_CASHBACK_HSOL_CONFIG_KEY',
  'MAINNET_MSKD_HSOL_CONFIG_KEY',
  'WALLET_WORKER_ENABLED',
  'MAINNET_TRADING_ENABLED',
  'LOCAL_VALIDATOR_ENABLED',
  'LOCAL_VALIDATOR_GENESIS_HASH',
  'NEXT_PUBLIC_SITE_URL',
  'SITE_ALLOWED_ORIGINS',
  'NEXT_PUBLIC_LOCAL_VALIDATOR_RPC_URL',
  'MSKD_PAYOUT_POOL',
  'MSKD_DEVNET_PAYOUT_MINT',
] as const;
export type WalletSignerConfig = {
  version: 1;
  purpose: 'rinsed-wallet-signer';
  keyFile: string;
  environment: Record<string, string>;
  limits: WalletSigningLimits;
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: unknown, keys: string[]) => {
  if (!object(v) || Object.keys(v).length !== keys.length || keys.some((k) => !Object.hasOwn(v, k)))
    throw new Error('Invalid signer configuration fields');
  return v;
};
export function walletSignerConfig(value: unknown): WalletSignerConfig {
  const policy = exact(value, ['version', 'purpose', 'keyFile', 'environment', 'limits']);
  if (
    policy.version !== 1 ||
    policy.purpose !== 'rinsed-wallet-signer' ||
    typeof policy.keyFile !== 'string' ||
    !path.isAbsolute(policy.keyFile) ||
    !object(policy.environment)
  )
    throw new Error('Invalid signer policy');
  const environment = policy.environment as Record<string, string>;
  for (const [key, v] of Object.entries(environment))
    if (
      !WALLET_SIGNER_ENVIRONMENT.includes(key as (typeof WALLET_SIGNER_ENVIRONMENT)[number]) ||
      typeof v !== 'string' ||
      v.length > 8192 ||
      v.includes('\0')
    )
      throw new Error('Invalid signer environment');
  for (const key of [
    'RPC_URL',
    'DATABASE_URL',
    'DATABASE_SSL_CA',
    'NEXT_PUBLIC_NETWORK',
    'FEE_COLLECTOR_PUBLIC_KEY',
    'TREASURY_PUBLIC_KEY',
  ])
    if (!environment[key]) throw new Error('Incomplete signer environment');
  const env: NodeJS.ProcessEnv = {
      ...environment,
      NODE_ENV: environment.NEXT_PUBLIC_NETWORK === 'localnet' ? 'test' : 'production',
    },
    genesis = expectedNetworkGenesis(env);
  companyWallets(env, genesis, { allowLegacy: true });
  if (genesis === NETWORK_GENESIS['mainnet-beta'] && env.LAUNCH_POLICY_VERSION === 'dev-v1') {
    const configKey = env.POOL_CONFIG_KEY;
    if (!configKey || new PublicKey(configKey).equals(PublicKey.default))
      throw new Error('The mainnet Dev signer needs a reviewed pool config pin');
  }
  const url = new URL(environment.RPC_URL!);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' && environment.NEXT_PUBLIC_NETWORK !== 'localnet')
  )
    throw new Error('Invalid private signer RPC');
  if (
    environment.WALLET_WORKER_ENABLED !== 'true' ||
    (genesis === NETWORK_GENESIS['mainnet-beta'] && environment.MAINNET_TRADING_ENABLED !== 'true')
  )
    throw new Error('Signer execution gates are disabled');
  if (
    !['postgres:', 'postgresql:'].includes(new URL(environment.DATABASE_URL!).protocol) ||
    !path.isAbsolute(environment.DATABASE_SSL_CA!)
  )
    throw new Error('Invalid private signer database');
  const limits = exact(policy.limits, [
    'maximumBuybackLamports',
    'maximumPayoutLamports',
    'maximumOperatingCostLamports',
    ...(object(policy.limits) && Object.hasOwn(policy.limits, 'maximumPayoutWxmrUnits')
      ? ['maximumPayoutWxmrUnits']
      : []),
  ]);
  for (const v of Object.values(limits))
    if (
      typeof v !== 'string' ||
      !/^\d{1,20}$/.test(v) ||
      BigInt(v) <= 0n ||
      BigInt(v) > 18446744073709551615n
    )
      throw new Error('Invalid signer execution limit');
  return policy as unknown as WalletSignerConfig;
}
/** Both descriptor and pathname must retain their original identity, contents and private permissions. */
export function readPrivateSignerJson(file: string, maximum: number): unknown {
  if (!path.isAbsolute(file)) throw new Error('Absolute private file required');
  const before = fs.lstatSync(file),
    parent = fs.lstatSync(path.dirname(file)),
    unix = process.platform !== 'win32';
  const permitted = (stat: fs.Stats) =>
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.size <= maximum &&
    (!unix || ((stat.mode & 0o077) === 0 && stat.uid === process.getuid?.()));
  const same = (stat: fs.Stats) =>
    permitted(stat) &&
    ['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'mtimeMs', 'ctimeMs'].every(
      (key) => stat[key as keyof fs.Stats] === before[key as keyof fs.Stats]
    );
  if (
    !permitted(before) ||
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (unix &&
      ((parent.mode & 0o022) !== 0 ||
        (parent.uid !== 0 && parent.uid !== process.getuid?.()) ||
        fs.realpathSync(file) !== path.resolve(file)))
  )
    throw new Error('Private file permissions rejected');
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
  );
  try {
    if (!same(fs.fstatSync(fd))) throw new Error('Private file changed before read');
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    try {
      while (length < bytes.length) {
        const n = fs.readSync(fd, bytes, length, bytes.length - length, null);
        if (n === 0) break;
        length += n;
      }
      if (
        length > maximum ||
        length !== before.size ||
        !same(fs.fstatSync(fd)) ||
        !same(fs.lstatSync(file))
      )
        throw new Error('Private file changed during read');
      return JSON.parse(bytes.subarray(0, length).toString('utf8'));
    } finally {
      bytes.fill(0);
    }
  } finally {
    fs.closeSync(fd);
  }
}
