const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { NETWORK_GENESIS } = require('./network-policy.cjs');
const { checkMainnetRings } = require('./otc-rings-preflight.cjs');

const appRequire = createRequire(require.resolve('../scaffolds/fun-launch/package.json'));
const { PublicKey, SystemProgram } = appRequire('@solana/web3.js');
const { AccountLayout, NATIVE_MINT, TOKEN_PROGRAM_ID } = appRequire('@solana/spl-token');

test('rejects another cluster before reading the Rings accounts', async () => {
  const result = await checkMainnetRings({
    getGenesisHash: async () => NETWORK_GENESIS.devnet,
    getMultipleAccountsInfoAndContext: () => assert.fail('unexpected account read'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'RPC_NETWORK_MISMATCH');
});

test('reports missing, non-executable and wrong-mint mainnet accounts', async () => {
  const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
  const wrongMint = Buffer.alloc(AccountLayout.span);
  NATIVE_MINT.toBuffer().copy(wrongMint);
  wrongMint[AccountLayout.offsetOf('state')] = 1;
  const result = await checkMainnetRings({
    getGenesisHash: async () => NETWORK_GENESIS['mainnet-beta'],
    getMultipleAccountsInfoAndContext: async (keys, commitment) => {
      assert.equal(commitment, 'finalized');
      assert.equal(keys.length, 5);
      return {
        context: { slot: 123 },
        value: [
          { owner: loader, executable: false },
          { owner: loader, executable: true },
          null,
          { owner: SystemProgram.programId, executable: false },
          { owner: TOKEN_PROGRAM_ID, executable: false, data: wrongMint },
        ],
      };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.finalizedSlot, 123);
  assert.deepEqual(
    result.accounts.filter((account) => !account.ok).map((account) => account.label),
    ['Privacy program', 'State tree', 'USDC interface']
  );
});
