const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  { createRequire } = require('node:module'),
  path = require('node:path');
const app = createRequire(path.resolve(__dirname, '../scaffolds/fun-launch/package.json')),
  { Keypair, PublicKey } = app('@solana/web3.js'),
  { companyWallets } = require('./company-wallets.cjs'),
  { NETWORK_GENESIS } = require('./network-policy.cjs'),
  owner = require('../docs/mainnet-authorities.public.json'),
  devCompany = require('../docs/mskd-mainnet-dev-wallets.public.json');
test('mainnet ordinary company wallets are pinned to owner-provided public roles', () => {
  const env = {
    FEE_COLLECTOR_PUBLIC_KEY: owner.company.collector,
    TREASURY_PUBLIC_KEY: owner.vault.treasury,
  };
  assert.equal(
    companyWallets(env, NETWORK_GENESIS['mainnet-beta']).collector.toBase58(),
    owner.company.collector
  );
  assert.throws(
    () =>
      companyWallets(
        { ...env, FEE_COLLECTOR_PUBLIC_KEY: Keypair.generate().publicKey.toBase58() },
        NETWORK_GENESIS['mainnet-beta']
      ),
    /owner-provided/
  );
  assert.throws(
    () =>
      companyWallets(
        { ...env, TREASURY_PUBLIC_KEY: Keypair.generate().publicKey.toBase58() },
        NETWORK_GENESIS['mainnet-beta']
      ),
    /owner-provided/
  );
});
test('mainnet Dev requires its own recorded collector and treasury', () => {
  const genesis = NETWORK_GENESIS['mainnet-beta'];
  const env = {
    LAUNCH_POLICY_VERSION: 'dev-v1',
    FEE_COLLECTOR_PUBLIC_KEY: devCompany.collector,
    TREASURY_PUBLIC_KEY: devCompany.treasury,
  };
  assert.equal(companyWallets(env, genesis).collector.toBase58(), devCompany.collector);
  assert.throws(
    () => companyWallets({ ...env, LAUNCH_POLICY_VERSION: 'bond-v1' }, genesis),
    /owner-provided/
  );
  assert.throws(
    () => companyWallets({ ...env, TREASURY_PUBLIC_KEY: owner.company.treasury }, genesis),
    /owner-provided/
  );
  assert.throws(
    () =>
      companyWallets(
        {
          ...env,
          FEE_COLLECTOR_PUBLIC_KEY: owner.legacyCompanyWallets[0].collector,
          TREASURY_PUBLIC_KEY: owner.legacyCompanyWallets[0].treasury,
        },
        genesis,
        { allowLegacy: true }
      ),
    /owner-provided/
  );
});
test('local/devnet aliases must be explicit ordinary wallets; no key generation or fallback occurs in helper', () => {
  const env = {
    FEE_COLLECTOR_PUBLIC_KEY: Keypair.generate().publicKey.toBase58(),
    TREASURY_PUBLIC_KEY: Keypair.generate().publicKey.toBase58(),
  };
  assert.equal(
    companyWallets(env, NETWORK_GENESIS.devnet).collector.toBase58(),
    env.FEE_COLLECTOR_PUBLIC_KEY
  );
  assert.equal(
    companyWallets(env, Keypair.generate().publicKey.toBase58()).treasury.toBase58(),
    env.TREASURY_PUBLIC_KEY
  );
  assert.throws(() => companyWallets({}, NETWORK_GENESIS.devnet), /Explicit/);
  const pda = PublicKey.findProgramAddressSync(
    [Buffer.from('fee-authority')],
    Keypair.generate().publicKey
  )[0];
  assert.throws(
    () =>
      companyWallets({ ...env, FEE_COLLECTOR_PUBLIC_KEY: pda.toBase58() }, NETWORK_GENESIS.devnet),
    /ordinary/
  );
});
test('retired collectors require explicit historical opt-in and cannot replace the active launch wallet', () => {
  const historical = owner.legacyCompanyWallets[0];
  const env = {
    FEE_COLLECTOR_PUBLIC_KEY: historical.collector,
    TREASURY_PUBLIC_KEY: historical.treasury,
  };
  assert.throws(() => companyWallets(env, NETWORK_GENESIS['mainnet-beta']), /owner-provided/);
  assert.equal(
    companyWallets(env, NETWORK_GENESIS['mainnet-beta'], {
      allowLegacy: true,
    }).collector.toBase58(),
    historical.collector
  );
  assert.throws(
    () =>
      companyWallets(
        { ...env, FEE_COLLECTOR_PUBLIC_KEY: Keypair.generate().publicKey.toBase58() },
        NETWORK_GENESIS['mainnet-beta'],
        { allowLegacy: true }
      ),
    /owner-provided/
  );
  assert.equal(owner.company.treasury, historical.treasury);
});
