import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  validateEnv,
  validateCheckpointConfig,
  publicBuildEnvironment,
  validatePublicBuildEnvironment,
} from './validate-env.mjs';

test('startup refuses a devnet build under mainnet runtime and never puts secrets in public build metadata', () => {
  const env = {
    NEXT_PUBLIC_NETWORK: 'devnet',
    NEXT_PUBLIC_POOL_CONFIG_KEY: 'fixture',
    RPC_URL: 'PRIVATE_RPC',
    ADMIN_SESSION_SECRET: 'PRIVATE_ADMIN',
  };
  const built = publicBuildEnvironment(env);
  assert.doesNotThrow(() => validatePublicBuildEnvironment(built, env));
  assert.throws(
    () => validatePublicBuildEnvironment(built, { ...env, NEXT_PUBLIC_NETWORK: 'mainnet-beta' }),
    /differs from runtime/
  );
  assert.doesNotMatch(JSON.stringify(built), /PRIVATE_RPC|PRIVATE_ADMIN|RPC_URL|ADMIN_SESSION/);
});

const valid = {
  RPC_URL: 'https://rpc.example',
  PINATA_JWT: 'test-jwt',
  POOL_CONFIG_KEY: '11111111111111111111111111111111',
  NEXT_PUBLIC_NETWORK: 'devnet',
  NEXT_PUBLIC_SITE_URL: 'https://launch.example',
};

test('accepts a complete deployment configuration', () => {
  assert.doesNotThrow(() => validateEnv(valid));
});
test('permits known historical collector pins only for a closed web transition, never live admission', () => {
  const roles = createRequire(import.meta.url)('../docs/mainnet-authorities.public.json');
  const env = {
    ...valid,
    NEXT_PUBLIC_NETWORK: 'mainnet-beta',
    LAUNCH_POLICY_VERSION: 'bond-v1',
    DATABASE_URL: 'postgresql://db.example/app',
    ADMIN_SESSION_SECRET: 'independent-recovery-secret-at-least-32-bytes',
    FEE_COLLECTOR_PUBLIC_KEY: roles.legacyCompanyWallets[0].collector,
    TREASURY_PUBLIC_KEY: roles.company.treasury,
    MAINNET_TRADING_ENABLED: 'false',
    WALLET_WORKER_ENABLED: 'false',
  };
  assert.doesNotThrow(() => validateEnv(env));
  assert.throws(() => validateEnv({ ...env, MAINNET_TRADING_ENABLED: 'true' }), /owner-provided/);
  assert.throws(() => validateEnv({ ...env, WALLET_WORKER_ENABLED: 'true' }), /owner-provided/);
});
test('Bond it. startup requires durable registration and a launch recovery secret even without admin login', () => {
  const roles = createRequire(import.meta.url)('../docs/mainnet-authorities.public.json');
  const env = {
    ...valid,
    LAUNCH_POLICY_VERSION: 'bond-v1',
    FEE_COLLECTOR_PUBLIC_KEY: roles.company.collector,
    TREASURY_PUBLIC_KEY: roles.vault.treasury,
  };
  assert.throws(() => validateEnv(env), /Postgres/);
  assert.throws(
    () => validateEnv({ ...env, DATABASE_URL: 'postgresql://db.example/app' }),
    /ADMIN_SESSION_SECRET/
  );
  assert.doesNotThrow(() =>
    validateEnv({
      ...env,
      DATABASE_URL: 'postgresql://db.example/app',
      ADMIN_SESSION_SECRET: 'independent-recovery-secret-at-least-32-bytes',
    })
  );
});
test('wallet workers require explicit ordinary recipients and durable storage, never native checkpoint settings', () => {
  const owner = createRequire(import.meta.url)('../docs/mainnet-authorities.public.json');
  const pins = {
    FEE_COLLECTOR_PUBLIC_KEY: owner.company.collector,
    TREASURY_PUBLIC_KEY: owner.vault.treasury,
  };
  assert.doesNotThrow(() => validateEnv({ ...valid, WALLET_WORKER_ENABLED: 'false' }));
  assert.throws(
    () => validateEnv({ ...valid, WALLET_WORKER_ENABLED: 'true' }),
    /collector|treasury/i
  );
  assert.throws(
    () => validateEnv({ ...valid, ...pins, WALLET_WORKER_ENABLED: 'true' }),
    /database/i
  );
  assert.doesNotThrow(() =>
    validateEnv({
      ...valid,
      ...pins,
      WALLET_WORKER_ENABLED: 'true',
      DATABASE_URL: 'postgres://db.example/app',
    })
  );
  assert.throws(() => validateEnv({ ...valid, FINANCIAL_WORKER_ENABLED: 'true' }), /Legacy native/);
  for (const signer of [
    { WALLET_SIGNER_KEYPAIR_FILE: '/private/key.json' },
    { WALLET_SIGNER_COMMAND_JSON: '["private"]' },
  ])
    assert.throws(() => validateEnv({ ...valid, ...signer }), /separate private signer/);
  const key = Buffer.alloc(32, 3).toString('base64');
  assert.throws(
    () => validateCheckpointConfig({ FINANCIAL_CHECKPOINT_HMAC_KEY: key, WHITELIST_SECRET: key }),
    /independent/
  );
});

test('rejects missing secrets without printing their values', () => {
  assert.throws(() => validateEnv({ ...valid, PINATA_JWT: '' }), /PINATA_JWT/);
});
test('rejects HTTP, non-canonical origins and invalid networks', () => {
  for (const NEXT_PUBLIC_SITE_URL of [
    'http://launch.example',
    'https://launch.example/path',
    'https://launch.example/',
    'https://user:pass@launch.example',
  ]) {
    assert.throws(() => validateEnv({ ...valid, NEXT_PUBLIC_SITE_URL }));
  }
  assert.throws(() => validateEnv({ ...valid, NEXT_PUBLIC_NETWORK: 'mainnet' }));
});
test('rejects mismatched config keys and insecure gateways', () => {
  assert.throws(() => validateEnv({ ...valid, NEXT_PUBLIC_POOL_CONFIG_KEY: 'different' }));
  assert.throws(() => validateEnv({ ...valid, IPFS_GATEWAY_URL: 'http://gateway.example' }));
});

test('validates additional domains separately from the single canonical origin', () => {
  assert.doesNotThrow(() =>
    validateEnv({ ...valid, SITE_ALLOWED_ORIGINS: 'https://rinsed.fun,https://www.rinsed.fun' })
  );
  for (const SITE_ALLOWED_ORIGINS of [
    'http://rinsed.fun',
    'https://rinsed.fun/path',
    'https://user:pass@rinsed.fun',
  ])
    assert.throws(() => validateEnv({ ...valid, SITE_ALLOWED_ORIGINS }));
  assert.throws(() =>
    validateEnv({ ...valid, NEXT_PUBLIC_SITE_URL: 'https://launch.example,https://rinsed.fun' })
  );
});

test('requires explicit mainnet company bindings and disables sample coins on mainnet', () => {
  assert.throws(
    () => validateEnv({ ...valid, MAINNET_TRADING_ENABLED: 'true' }),
    /requires the explicitly selected mainnet/
  );
  assert.throws(
    () =>
      validateEnv({
        ...valid,
        NEXT_PUBLIC_NETWORK: 'mainnet-beta',
        NEXT_PUBLIC_DEMO_LAUNCHES: 'true',
      }),
    /Demo launches/
  );
});

test('leaves admin access closed without a key and validates configured admin credentials', () => {
  assert.doesNotThrow(() => validateEnv(valid));
  assert.throws(() => validateEnv({ ...valid, ADMIN_KEY_HASH: 'plaintext-key' }), /ADMIN_KEY_HASH/);
  const ADMIN_KEY_HASH = `pbkdf2-sha256$600000$${'a'.repeat(32)}$${'b'.repeat(64)}`;
  assert.throws(() => validateEnv({ ...valid, ADMIN_KEY_HASH }), /ADMIN_SESSION_SECRET/);
  assert.throws(
    () => validateEnv({ ...valid, ADMIN_KEY_HASH, ADMIN_SESSION_SECRET: 's'.repeat(48) }),
    /storage/
  );
  assert.doesNotThrow(() =>
    validateEnv({
      ...valid,
      ADMIN_KEY_HASH,
      ADMIN_SESSION_SECRET: 's'.repeat(48),
      DATABASE_URL: 'postgres://db.example/app',
      WHITELIST_SECRET: 'w'.repeat(48),
    })
  );
});

test('validates admin epoch and revocation cutoff without changing credentials', () => {
  const admin = {
    ...valid,
    ADMIN_KEY_HASH: `pbkdf2-sha256$600000$${'a'.repeat(32)}$${'b'.repeat(64)}`,
    ADMIN_SESSION_SECRET: 's'.repeat(48),
    DATABASE_URL: 'postgres://db.example/app',
    WHITELIST_SECRET: 'w'.repeat(48),
  };
  assert.doesNotThrow(() =>
    validateEnv({
      ...admin,
      ADMIN_SESSION_EPOCH: 'incident-2026',
      ADMIN_SESSION_NOT_BEFORE_MS: '1793140000000',
    })
  );
  for (const invalid of [
    { ADMIN_SESSION_EPOCH: '' },
    { ADMIN_SESSION_EPOCH: '<script>' },
    { ADMIN_SESSION_NOT_BEFORE_MS: '-1' },
    { ADMIN_SESSION_NOT_BEFORE_MS: '9007199254740992' },
  ])
    assert.throws(() => validateEnv({ ...admin, ...invalid }), /ADMIN_SESSION/);
});

const local = {
  ...valid,
  NODE_ENV: 'development',
  NEXT_PUBLIC_NETWORK: 'localnet',
  LOCAL_VALIDATOR_ENABLED: 'true',
  LOCAL_VALIDATOR_GENESIS_HASH: '11111111111111111111111111111111',
  RPC_URL: 'http://127.0.0.1:8899',
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3002',
};
test('permits an explicitly pinned, nonproduction loopback-only local rehearsal', () => {
  assert.doesNotThrow(() => validateEnv(local));
  assert.doesNotThrow(() => validateEnv({ ...local, RPC_URL: 'http://[::1]:8899' }));
});
test('local validator overrides cannot select production, remote RPC, public origins or known live chains', () => {
  for (const invalid of [
    { NODE_ENV: 'production' },
    { RPC_URL: 'https://rpc.example' },
    { RPC_URL: 'http://127.0.0.1.evil.test:8899' },
    { RPC_URL: 'http://user:password@localhost:8899' },
    { NEXT_PUBLIC_SITE_URL: 'https://rinsed.fun' },
    { SITE_ALLOWED_ORIGINS: 'https://rinsed.fun' },
    { LOCAL_VALIDATOR_GENESIS_HASH: '' },
    { NEXT_PUBLIC_NETWORK: 'devnet' },
    { LOCAL_VALIDATOR_ENABLED: 'false' },
    { LOCAL_VALIDATOR_GENESIS_HASH: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' },
    { LOCAL_VALIDATOR_GENESIS_HASH: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' },
    { LOCAL_VALIDATOR_GENESIS_HASH: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY' },
  ])
    assert.throws(() => validateEnv({ ...local, ...invalid }));
});
