const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const app = createRequire(path.resolve(__dirname, '../scaffolds/fun-launch/package.json'));
const {
  assertPinned,
  curveTemplate,
  assertPacket,
  rehearsalArguments,
} = require('./local-meteora-rehearsal.cjs');
const { Connection, Keypair } = app('@solana/web3.js');
const { NATIVE_MINT } = app('@solana/spl-token');
const { DynamicBondingCurveClient } = app('@meteora-ag/dynamic-bonding-curve-sdk');
const { getFeeSchedulerMinBaseFeeNumerator } = app('@meteora-ag/dynamic-bonding-curve-sdk');
const BN = app('bn.js');
const genesis = Keypair.generate().publicKey.toBase58();
const env = {
  NODE_ENV: 'development',
  LOCAL_VALIDATOR_ENABLED: 'true',
  NEXT_PUBLIC_NETWORK: 'localnet',
  LOCAL_VALIDATOR_GENESIS_HASH: genesis,
  RPC_URL: 'http://127.0.0.1:8899',
  NEXT_PUBLIC_SITE_URL: 'http://127.0.0.1:3000',
};
const sender = { fixture: { rpcUrl: env.RPC_URL, networkGenesis: genesis } };
test('actual protocol rehearsal requires an independent local-only genesis pin', () => {
  assert.doesNotThrow(() => assertPinned(sender, env));
  assert.throws(() => assertPinned(sender, { ...env, NODE_ENV: 'production' }));
  assert.throws(() =>
    assertPinned(sender, { ...env, RPC_URL: 'https://api.mainnet-beta.solana.com' })
  );
  assert.throws(() =>
    assertPinned(sender, {
      ...env,
      LOCAL_VALIDATOR_GENESIS_HASH: Keypair.generate().publicKey.toBase58(),
    })
  );
  for (const live of [
    '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  ])
    assert.throws(() =>
      assertPinned(
        { fixture: { ...sender.fixture, networkGenesis: live } },
        { ...env, LOCAL_VALIDATOR_GENESIS_HASH: live }
      )
    );
});
test('alternate state files cannot escape or overwrite unrelated local fixtures', () => {
  assert.equal(rehearsalArguments(['--post']).phase, 'post');
  assert.equal(rehearsalArguments(['--graduate-unbound']).phase, 'graduate-unbound');
  assert.equal(
    rehearsalArguments(['--prepare', '--state-file', '.local/meteora-rehearsal-state-fresh.json'])
      .statePath,
    path.resolve('.local/meteora-rehearsal-state-fresh.json')
  );
  const isolatedMainnet = rehearsalArguments([
    '--prepare',
    '--state-file',
    '.local/meteora-mainnet-binary-state.json',
    '--fixture-file',
    '.local/mainnet-binary-fixture.json',
  ]);
  assert.equal(isolatedMainnet.fixturePath, path.resolve('.local/mainnet-binary-fixture.json'));
  for (const args of [
    ['--prepare', '--post'],
    ['--prepare', '--state-file'],
    ['--prepare', '--state-file', '.local/mainnet-rehearsal-fixture.json'],
    ['--prepare', '--state-file', '../meteora-rehearsal-state-escape.json'],
    ['--prepare', '--fixture-file', '.local/isolated-finance-config.json'],
    ['--prepare', '--fixture-file', '../mainnet-binary-fixture.json'],
    [
      '--prepare',
      '--fixture-file',
      '.local/mainnet-binary-fixture.json',
      '--fixture-file',
      '.local/mainnet-binary-fixture.json',
    ],
  ])
    assert.throws(() => rehearsalArguments(args));
});
test('the real reviewed SDK config builder fits a legacy packet without RPC or funded keys', async () => {
  const client = new DynamicBondingCurveClient(new Connection(env.RPC_URL), 'confirmed');
  const payer = Keypair.generate().publicKey;
  const tx = await client.partner.createConfig({
    config: Keypair.generate().publicKey,
    quoteMint: NATIVE_MINT,
    feeClaimer: Keypair.generate().publicKey,
    leftoverReceiver: Keypair.generate().publicKey,
    payer,
    ...curveTemplate(),
  });
  assert.ok(assertPacket(tx, payer) <= 1232);
  assert.equal(tx.recentBlockhash, undefined);
});
test('the reviewed exponential schedule reports its actual integer floor without claiming exact1.25%', () => {
  const base = curveTemplate().poolFees.baseFee;
  assert.equal(base.cliffFeeNumerator.toString(), '900000000');
  assert.equal(base.firstFactor, 9);
  assert.equal(base.secondFactor.toString(), '3');
  assert.equal(base.thirdFactor.toString(), '3782');
  const floor = (factor) =>
    getFeeSchedulerMinBaseFeeNumerator(base.cliffFeeNumerator, 9, new BN(factor), 1);
  assert.equal(floor(3782).toString(), '12505439');
  assert.equal(floor(3783).toString(), '12487350');
  for (let factor = 0; factor < 10000; factor++)
    assert.notEqual(floor(factor).toString(), '12500000');
});
