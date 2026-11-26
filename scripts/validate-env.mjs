import {
  localValidatorPolicy,
  expectedNetworkGenesis,
  MAINNET_REWARD_PINS,
} from './network-policy.cjs';
import modePolicy from '../scaffolds/fun-launch/src/constants/modePolicy.json' with { type: 'json' };
const modeForPolicy = (version) =>
  Object.values(modePolicy.modes).some((mode) => mode.policyVersion === version);
import { companyWallets } from './company-wallets.cjs';
const publicBuildKeys = [
  'NEXT_PUBLIC_NETWORK',
  'NEXT_PUBLIC_POOL_CONFIG_KEY',
  'NEXT_PUBLIC_SITE_URL',
  'NEXT_PUBLIC_DEMO_LAUNCHES',
];
export function publicBuildEnvironment(env = process.env) {
  return Object.fromEntries(publicBuildKeys.map((key) => [key, env[key] ?? null]));
}
export function validatePublicBuildEnvironment(built, env = process.env) {
  const runtime = publicBuildEnvironment(env);
  if (
    !built ||
    typeof built !== 'object' ||
    Array.isArray(built) ||
    Object.keys(built).length !== publicBuildKeys.length ||
    publicBuildKeys.some((key) => !Object.hasOwn(built, key) || built[key] !== runtime[key])
  )
    throw new Error(
      'Public build configuration differs from runtime. Rebuild with the current public deployment settings.'
    );
}
export function validateCheckpointConfig(env = process.env) {
  const decode = (value) => {
    if (
      typeof value !== 'string' ||
      value.length > 4096 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    )
      throw new Error(
        'FINANCIAL_CHECKPOINT_HMAC_KEY and verification keys must be canonical base64'
      );
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length < 32 || bytes.toString('base64') !== value)
      throw new Error('Checkpoint authentication keys require at least 32 random bytes');
    return bytes;
  };
  const active = decode(env.FINANCIAL_CHECKPOINT_HMAC_KEY);
  for (const other of [env.WHITELIST_SECRET, env.ADMIN_SESSION_SECRET].filter(Boolean))
    if (other === env.FINANCIAL_CHECKPOINT_HMAC_KEY || active.equals(Buffer.from(other)))
      throw new Error('Checkpoint authentication must use an independent operator secret');
  const keyId = env.FINANCIAL_CHECKPOINT_KEY_ID || 'primary';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) throw new Error('Invalid FINANCIAL_CHECKPOINT_KEY_ID');
  const serialized = env.FINANCIAL_CHECKPOINT_VERIFY_KEYS_JSON || '{}';
  if (serialized.length > 64 * 1024)
    throw new Error('Checkpoint verification keyring exceeds capacity');
  let ring;
  try {
    ring = JSON.parse(serialized);
  } catch {
    throw new Error('Invalid FINANCIAL_CHECKPOINT_VERIFY_KEYS_JSON');
  }
  if (!ring || Array.isArray(ring) || typeof ring !== 'object')
    throw new Error('Invalid checkpoint verification keyring');
  for (const [id, value] of Object.entries(ring)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id))
      throw new Error('Invalid checkpoint verification key identifier');
    const prior = decode(value);
    if (id === keyId && !prior.equals(active))
      throw new Error('Checkpoint key identifier maps to conflicting secrets');
  }
}
export function validateEnv(env = process.env) {
  const localValidator = localValidatorPolicy(env);
  // A closed, read-only web release can display historical coins while wallet pins are rotated.
  const historicalDisplayOnly =
    env.MAINNET_TRADING_ENABLED === 'false' && env.WALLET_WORKER_ENABLED !== 'true';
  for (const [key, value] of Object.entries(env))
    if (
      value &&
      /^(?:.*PRIVATE_KEY.*|.*SECRET_KEY.*|.*KEYPAIR.*|.*SIGNER_.*|FINANCIAL_CHECKPOINT_(?:HMAC_KEY|VERIFY_KEYS_JSON)|ANCHOR_WALLET$|SOLANA_KEY.*)$/.test(
        key
      )
    )
      throw new Error(
        'Signing keys and signer settings belong only in the separate private signer process'
      );
  if (env.FINANCIAL_WORKER_ENABLED === 'true')
    throw new Error('Legacy native worker settings cannot configure the wallet-v1 deployment');
  for (const key of [
    'WALLET_WORKER_ENABLED',
    'MAINNET_TRADING_ENABLED',
    'LAUNCHPAD_PUBLIC',
    'DISPLAY_INDEXER',
  ])
    if (env[key] !== undefined && !['true', 'false'].includes(env[key]))
      throw new Error(`Invalid ${key}`);
  if (
    env.LAUNCH_POLICY_VERSION &&
    !['wallet-v1', 'bond-v1'].includes(env.LAUNCH_POLICY_VERSION) &&
    !modeForPolicy(env.LAUNCH_POLICY_VERSION)
  )
    throw new Error('Unknown launch policy version');
  const required = [
    'RPC_URL',
    'POOL_CONFIG_KEY',
    'PINATA_JWT',
    'NEXT_PUBLIC_NETWORK',
    'NEXT_PUBLIC_SITE_URL',
  ];
  const missing = required.filter((key) => !env[key] || /^(your_|replace_)/i.test(env[key]));
  if (missing.length) throw new Error(`Set required config vars: ${missing.join(', ')}`);
  if (env.LAUNCH_POLICY_VERSION === 'bond-v1' || modeForPolicy(env.LAUNCH_POLICY_VERSION)) {
    if (!env.DATABASE_URL || !/^postgres(?:ql)?:\/\//.test(env.DATABASE_URL))
      throw new Error('Bond it. launches require a Postgres database');
    if (
      !env.ADMIN_SESSION_SECRET ||
      env.ADMIN_SESSION_SECRET.length < 32 ||
      /^(your_|replace_)/i.test(env.ADMIN_SESSION_SECRET)
    )
      throw new Error('Bond it. launch receipt recovery requires ADMIN_SESSION_SECRET');
    companyWallets(env, expectedNetworkGenesis(env), { allowLegacy: historicalDisplayOnly });
  }
  if (
    !['devnet', 'mainnet-beta', ...(localValidator ? ['localnet'] : [])].includes(
      env.NEXT_PUBLIC_NETWORK
    )
  )
    throw new Error('Invalid NEXT_PUBLIC_NETWORK');
  if (env.ADMIN_KEY_HASH) {
    if (
      env.ADMIN_SESSION_EPOCH !== undefined &&
      !/^[A-Za-z0-9_-]{1,64}$/.test(env.ADMIN_SESSION_EPOCH)
    )
      throw new Error('Invalid ADMIN_SESSION_EPOCH');
    if (
      env.ADMIN_SESSION_NOT_BEFORE_MS !== undefined &&
      (!/^\d{1,16}$/.test(env.ADMIN_SESSION_NOT_BEFORE_MS) ||
        !Number.isSafeInteger(Number(env.ADMIN_SESSION_NOT_BEFORE_MS)))
    )
      throw new Error('Invalid ADMIN_SESSION_NOT_BEFORE_MS');
    if (!/^pbkdf2-sha256\$600000\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(env.ADMIN_KEY_HASH))
      throw new Error('Invalid ADMIN_KEY_HASH; use scripts/setup-admin.mjs');
    if (!env.ADMIN_SESSION_SECRET || env.ADMIN_SESSION_SECRET.length < 32)
      throw new Error('Admin access requires a strong ADMIN_SESSION_SECRET');
    if (!env.DATABASE_URL || !env.WHITELIST_SECRET || env.WHITELIST_SECRET.length < 32)
      throw new Error(
        'Admin sign-in requires persistent Postgres storage and a strong rate-limit secret'
      );
  }
  if (env.NEXT_PUBLIC_NETWORK === 'mainnet-beta' && env.NEXT_PUBLIC_DEMO_LAUNCHES === 'true')
    throw new Error('Demo launches must be disabled on mainnet');
  if (env.DISPLAY_INDEXER === 'true' && !/^postgres(?:ql)?:\/\//.test(env.DATABASE_URL || ''))
    throw new Error('The display indexer requires a Postgres database');
  if (env.RPC_FALLBACK_URL && new URL(env.RPC_FALLBACK_URL).protocol !== 'https:' && !localValidator)
    throw new Error('RPC_FALLBACK_URL must use HTTPS');
  if (env.MAINNET_TRADING_ENABLED === 'true' && env.NEXT_PUBLIC_NETWORK !== 'mainnet-beta')
    throw new Error('MAINNET_TRADING_ENABLED requires the explicitly selected mainnet network');
  if (
    env.WALLET_WORKER_ENABLED === 'true' ||
    env.MAINNET_TRADING_ENABLED === 'true' ||
    env.FEE_COLLECTOR_PUBLIC_KEY ||
    env.TREASURY_PUBLIC_KEY
  ) {
    companyWallets(env, expectedNetworkGenesis(env), { allowLegacy: historicalDisplayOnly });
    if (!env.DATABASE_URL)
      throw new Error('Wallet financial execution requires durable database storage');
  }
  const origin = new URL(env.NEXT_PUBLIC_SITE_URL);
  if (
    (origin.protocol !== 'https:' && !(localValidator && origin.protocol === 'http:')) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new Error('NEXT_PUBLIC_SITE_URL must be an HTTPS origin, without a path or credentials');
  }
  if (env.NEXT_PUBLIC_SITE_URL !== origin.origin)
    throw new Error('NEXT_PUBLIC_SITE_URL must have no trailing slash');
  for (const value of (env.SITE_ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)) {
    const allowed = new URL(value);
    if (
      (allowed.protocol !== 'https:' && !(localValidator && allowed.protocol === 'http:')) ||
      allowed.origin !== value ||
      allowed.username ||
      allowed.password
    )
      throw new Error(
        'SITE_ALLOWED_ORIGINS must contain exact HTTPS origins, without paths or credentials'
      );
  }
  const rpc = new URL(env.RPC_URL);
  if (rpc.protocol !== 'https:' && !localValidator) throw new Error('RPC_URL must use HTTPS');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(env.POOL_CONFIG_KEY))
    throw new Error('Invalid POOL_CONFIG_KEY');
  const rewardPins = Object.values(MAINNET_REWARD_PINS)
    .map((name) => env[name])
    .filter(Boolean);
  if (
    rewardPins.length &&
    (env.NEXT_PUBLIC_NETWORK !== 'mainnet-beta' ||
      env.LAUNCH_POLICY_VERSION !== 'dev-v1' ||
      rewardPins.some((key) => !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key)) ||
      new Set([env.POOL_CONFIG_KEY, ...rewardPins]).size !== rewardPins.length + 1)
  )
    throw new Error('Mainnet reward modes require distinct reviewed pool config pins');
  if (env.NEXT_PUBLIC_POOL_CONFIG_KEY && env.NEXT_PUBLIC_POOL_CONFIG_KEY !== env.POOL_CONFIG_KEY) {
    throw new Error('Public and server pool config keys must match');
  }
  const gateway = new URL(env.IPFS_GATEWAY_URL || 'https://gateway.pinata.cloud');
  if (
    gateway.protocol !== 'https:' ||
    gateway.username ||
    gateway.password ||
    gateway.port ||
    gateway.pathname !== '/' ||
    gateway.search ||
    gateway.hash
  ) {
    throw new Error('IPFS_GATEWAY_URL must be an HTTPS origin');
  }
}
