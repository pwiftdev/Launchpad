const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertLocalRpc, createLocalSender } = require('./local-vm-sender.cjs');
const { NETWORK_GENESIS } = require('./network-policy.cjs');

test('rehearsal signer rejects remote URLs, alternate local ports and URL credentials', () => {
  assert.doesNotThrow(() => assertLocalRpc('http://127.0.0.1:8899'));
  for (const rpc of [
    'https://api.mainnet-beta.solana.com',
    'http://127.0.0.1:8898',
    'http://user:pass@127.0.0.1:8899',
    'http://127.0.0.1:8899/?upstream=live',
    'http://127.0.0.1:8899/relay',
  ])
    assert.throws(() => assertLocalRpc(rpc));
});

test('a loopback proxy to any known public cluster is rejected before RPC or SSH signing', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rinsed-local-safety-'));
  const fixturePath = path.join(directory, 'public-fixture.json');
  try {
    for (const networkGenesis of [
      ...Object.values(NETWORK_GENESIS),
      '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
    ]) {
      fs.writeFileSync(
        fixturePath,
        JSON.stringify({
          profile: 'devnet-binaries',
          rpcUrl: 'http://127.0.0.1:8899',
          networkGenesis,
        })
      );
      await assert.rejects(createLocalSender({ fixturePath }), /genesis mismatch/);
    }
  } finally {
    if (fs.existsSync(fixturePath)) fs.unlinkSync(fixturePath);
    fs.rmdirSync(directory);
  }
});

test('production refuses the signer before opening even its public fixture', async () => {
  const before = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    await assert.rejects(
      createLocalSender({ fixturePath: 'this-file-does-not-exist.json' }),
      /unavailable in production/
    );
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
});

test('a fixture cannot choose an arbitrary VM signing directory', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rinsed-profile-safety-'));
  const fixturePath = path.join(directory, 'fixture.json');
  try {
    fs.writeFileSync(
      fixturePath,
      JSON.stringify({ profile: '../../private', rpcUrl: 'http://127.0.0.1:8899' })
    );
    await assert.rejects(createLocalSender({ fixturePath }), /Unknown isolated signing profile/);
  } finally {
    fs.unlinkSync(fixturePath);
    fs.rmdirSync(directory);
  }
});
