import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deploymentReadiness } from './deployment-readiness.mjs';
const roles = createRequire(import.meta.url)('../docs/mainnet-authorities.public.json');
const staged = {
  RPC_URL: 'https://rpc.example/PRIVATE_RPC_TOKEN',
  PINATA_JWT: 'PRIVATE_PINATA_TOKEN',
  DATABASE_URL: 'postgresql://db.example/launchpad',
  POOL_CONFIG_KEY: '11111111111111111111111111111111',
  NEXT_PUBLIC_POOL_CONFIG_KEY: '11111111111111111111111111111111',
  FEE_COLLECTOR_PUBLIC_KEY: roles.company.collector,
  TREASURY_PUBLIC_KEY: roles.vault.treasury,
  NEXT_PUBLIC_NETWORK: 'mainnet-beta',
  NEXT_PUBLIC_SITE_URL: 'https://plzzz.bond',
  LAUNCH_POLICY_VERSION: 'bond-v1',
  ADMIN_SESSION_SECRET: 'independent-launch-recovery-secret-at-least-32-characters',
  NEXT_PUBLIC_DEMO_LAUNCHES: 'false',
  WHITELIST_ENABLED: 'false',
  NEXT_PUBLIC_WHITELIST_ENABLED: 'false',
  WALLET_WORKER_ENABLED: 'false',
  MAINNET_TRADING_ENABLED: 'false',
  LAUNCHPAD_PUBLIC: 'false',
};
test('accepts staged configuration without claiming chain, signer or live readiness', () => {
  const report = deploymentReadiness(staged);
  assert.equal(report.configurationChecksPassed, true);
  assert.equal(report.activationEnabled, false);
  assert.ok(report.unverified.includes('onChainConfigAndRegistry'));
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|postgresql:|rpc\.example/);
});
test('catches old policies, wrong domains, demo markets and web signer settings', () => {
  for (const change of [
    { LAUNCH_POLICY_VERSION: 'wallet-v1' },
    { NEXT_PUBLIC_SITE_URL: 'https://rinsed.fun' },
    { DATABASE_URL: '' },
    { NEXT_PUBLIC_DEMO_LAUNCHES: 'true' },
    { NEXT_PUBLIC_POOL_CONFIG_KEY: '' },
    { NEXT_PUBLIC_WHITELIST_ENABLED: 'true' },
    { WALLET_WORKER_ENABLED: 'true' },
    { WALLET_SIGNER_COMMAND_JSON: 'PRIVATE_SIGNER' },
  ])
    assert.equal(deploymentReadiness({ ...staged, ...change }).configurationChecksPassed, false);
});
test('accepts the existing Heroku origin while custom-domain DNS is deferred', () => {
  assert.equal(
    deploymentReadiness({
      ...staged,
      NEXT_PUBLIC_SITE_URL: 'https://rinsed-launchpad-1675f6b9bebf.herokuapp.com',
    }).configurationChecksPassed,
    true
  );
});
test('a retired wallet is not deployment-ready even when a closed web release can still boot', () => {
  assert.equal(
    deploymentReadiness({
      ...staged,
      FEE_COLLECTOR_PUBLIC_KEY: roles.legacyCompanyWallets[0].collector,
    }).configurationChecksPassed,
    false
  );
});
