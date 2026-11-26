const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  configuration,
  decodeSigningKey,
  cycleProfile,
  automaticArguments,
  PINS,
  DEV_PINS,
} = require('../deploy/private-worker/bootstrap.cjs');
function environment() {
  return {
    WALLET_PRIVATE_WORKER: 'true',
    WALLET_WORKER_ENABLED: 'true',
    NEXT_PUBLIC_NETWORK: 'mainnet-beta',
    MAINNET_TRADING_ENABLED: 'true',
    POOL_CONFIG_KEY: PINS.configKey,
    WALLET_CONFIG_SHA256: PINS.configDigest,
    FEE_COLLECTOR_PUBLIC_KEY: PINS.collector,
    TREASURY_PUBLIC_KEY: PINS.treasury,
    RPC_URL: 'https://rpc.example.invalid',
    DATABASE_URL: 'postgresql://fixture:fixture@db.example.invalid/fixture',
    WALLET_AUTOMATIC_ENABLED: 'true',
    WALLET_MAXIMUM_BUYBACK_LAMPORTS: '10000000',
    WALLET_MAXIMUM_PAYOUT_LAMPORTS: '1000000000',
    WALLET_MAXIMUM_OPERATING_COST_LAMPORTS: '5000000',
  };
}
test('only the new collector can use automatic signing; historical cycles never receive a signer command', () => {
  const env = {
    POOL_CONFIG_KEY: PINS.configKey,
    FEE_COLLECTOR_PUBLIC_KEY: PINS.collector,
    TREASURY_PUBLIC_KEY: PINS.treasury,
  };
  const current = cycleProfile(0, env, true),
    legacy = cycleProfile(1, env, true);
  assert.equal(current.automatic, true);
  assert.deepEqual(automaticArguments(current.automatic, '/private/command.json'), [
    '--automatic',
    '--signer-config',
    '/private/command.json',
  ]);
  assert.equal(legacy.automatic, false);
  assert.deepEqual(automaticArguments(legacy.automatic, '/private/command.json'), []);
  assert.equal(legacy.environment.FEE_COLLECTOR_PUBLIC_KEY, PINS.legacyCollector);
  assert.equal(legacy.environment.POOL_CONFIG_KEY, PINS.legacyConfigKey);
  assert.equal(env.FEE_COLLECTOR_PUBLIC_KEY, PINS.collector);
  assert.equal(cycleProfile(2, env, false).automatic, false);
});
test('a swapped collector, mixed public role or unrelated secret cannot start the private worker', () => {
  const manifest = {
    configKey: PINS.configKey,
    configDigest: PINS.configDigest,
    collector: PINS.collector,
    treasury: PINS.treasury,
  };
  assert.equal(configuration(manifest, environment()).automatic, true);
  assert.throws(
    () =>
      configuration(manifest, { ...environment(), FEE_COLLECTOR_PUBLIC_KEY: PINS.legacyCollector }),
    /REVIEWED_CONFIG/
  );
  assert.throws(
    () => configuration(manifest, { ...environment(), HEROKU_APP_NAME: 'rinsed-launchpad' }),
    /PRIVATE_WORKER_ROLE/
  );
  assert.throws(
    () => configuration(manifest, { ...environment(), UNRELATED_SECRET_KEY: 'fixture' }),
    /MIXED_OR_UNSAFE/
  );
  assert.equal(
    configuration(manifest, {
      ...environment(),
      LEGACY_WALLET_SIGNER_SECRET_KEY_JSON: 'rollback-only',
    }).automatic,
    true
  );
});
test('the Dev worker keeps every cycle on its pinned mainnet policy', () => {
  const manifest = { ...DEV_PINS, policyVersion: 'dev-v1' };
  const env = {
    ...environment(),
    LAUNCH_POLICY_VERSION: 'dev-v1',
    POOL_CONFIG_KEY: DEV_PINS.configKey,
    WALLET_CONFIG_SHA256: DEV_PINS.configDigest,
    FEE_COLLECTOR_PUBLIC_KEY: DEV_PINS.collector,
    TREASURY_PUBLIC_KEY: DEV_PINS.treasury,
  };
  assert.equal(configuration(manifest, env).automatic, true);
  assert.deepEqual(cycleProfile(1, env, true), { name: 'dev', automatic: true, environment: env });
  assert.throws(
    () => configuration(manifest, { ...env, LAUNCH_POLICY_VERSION: 'bond-v1' }),
    /REVIEWED_CONFIG/
  );
});
test('signer setup validates the seed and derived collector, rather than trusting the public half', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const publicBytes = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const secret = Buffer.concat([seed, publicBytes]);
  const decoded = decodeSigningKey(JSON.stringify([...secret]), publicBytes.toString('hex'));
  assert.deepEqual(decoded, secret);
  assert.throws(
    () => decodeSigningKey(JSON.stringify([...secret]), PINS.collectorHex),
    /IDENTITY_MISMATCH/
  );
  const forged = Buffer.from(secret);
  forged[63] ^= 1;
  assert.throws(
    () => decodeSigningKey(JSON.stringify([...forged]), forged.subarray(32).toString('hex')),
    /IDENTITY_MISMATCH/
  );
  decoded.fill(0);
  secret.fill(0);
  forged.fill(0);
});
