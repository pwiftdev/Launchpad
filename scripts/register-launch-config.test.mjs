import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const app = createRequire(new URL('../scaffolds/fun-launch/package.json', import.meta.url)),
  { PublicKey, Keypair } = app('@solana/web3.js'),
  { BorshCoder } = app('@coral-xyz/anchor'),
  { convertIdlToCamelCase } = app('@coral-xyz/anchor/dist/cjs/idl.js'),
  sdk = app('@meteora-ag/dynamic-bonding-curve-sdk'),
  BN = app('bn.js');
import { NETWORK_GENESIS } from './network-policy.cjs';
function fixture() {
  const collector = Keypair.generate().publicKey,
    treasury = Keypair.generate().publicKey,
    key = Keypair.generate().publicKey,
    idl = convertIdlToCamelCase(sdk.DynamicBondingCurveIdl),
    coder = new BorshCoder(idl);
  const zero = (type) => {
    if (typeof type === 'string') {
      if (type === 'pubkey') return PublicKey.default;
      if (['u64', 'u128', 'i64', 'i128', 'u256', 'i256'].includes(type)) return new BN(0);
      return type === 'bool' ? false : 0;
    }
    if (type.array) return Array.from({ length: type.array[1] }, () => zero(type.array[0]));
    if (type.defined)
      return Object.fromEntries(
        idl.types
          .find((row) => row.name === type.defined.name)
          .type.fields.map((field) => [field.name, zero(field.type)])
      );
    throw Error('Unexpected fixture type');
  };
  const state = zero({ defined: { name: 'poolConfig' } }),
    fields = {
      quoteMint: new PublicKey('So11111111111111111111111111111111111111112'),
      feeClaimer: collector,
      leftoverReceiver: treasury,
      poolFees: {
        baseFee: {
          cliffFeeNumerator: 990000000,
          baseFeeMode: 0,
          firstFactor: 1,
          secondFactor: 1,
          thirdFactor: 977500000,
        },
        dynamicFee: { initialized: 0 },
      },
      activationType: 0,
      enableFirstSwapWithMinFee: true,
      collectFeeMode: 0,
      tokenDecimal: 6,
      tokenType: 0,
      tokenUpdateAuthority: 1,
      preMigrationTokenSupply: '1000000000000000',
      postMigrationTokenSupply: '1000000000000000',
      migrationQuoteThreshold: '80000000000',
      migrationOption: 1,
      migrationFeeOption: 6,
      migratedPoolFeeBps: 100,
      migratedPoolBaseFeeMode: 0,
      migratedCollectFeeMode: 0,
      migratedDynamicFee: 0,
      partnerPermanentLockedLiquidityPercentage: 100,
    };
  const merge = (target, source) => {
    for (const [name, value] of Object.entries(source)) {
      if (BN.isBN(target[name])) target[name] = new BN(String(value));
      else if (value && typeof value === 'object' && !(value instanceof PublicKey))
        merge(target[name], value);
      else target[name] = value;
    }
  };
  merge(state, fields);
  const buffer = Buffer.alloc(16384),
    size = coder.accounts.accountLayouts.get('poolConfig').layout.encode(state, buffer),
    data = Buffer.concat([
      coder.accounts.accountDiscriminator('poolConfig'),
      buffer.subarray(0, size),
    ]);
  return {
    collector,
    treasury,
    key,
    data,
    digest: createHash('sha256').update(data).digest('hex'),
  };
}
async function checkConfig(change = {}, entry = 'register-launch-config.mjs') {
  const f = fixture(),
    calls = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push(body.method);
    let result;
    if (body.method === 'getGenesisHash') result = NETWORK_GENESIS.devnet;
    else if (body.method === 'getAccountInfo') {
      assert.equal(body.params[0], f.key.toBase58());
      result = {
        context: { slot: 123 },
        value: {
          owner: sdk.DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58(),
          data: [f.data.toString('base64'), 'base64'],
          executable: false,
          lamports: 1,
          rentEpoch: 0,
        },
      };
    } else assert.fail(`Unexpected RPC method ${body.method}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL(`./${entry}`, import.meta.url))],
        {
          env: {
            ...process.env,
            RPC_URL: `http://127.0.0.1:${server.address().port}`,
            NEXT_PUBLIC_NETWORK: 'devnet',
            POOL_CONFIG_KEY: f.key.toBase58(),
            EXPECTED_CONFIG_DIGEST: f.digest,
            FEE_COLLECTOR_PUBLIC_KEY: f.collector.toBase58(),
            TREASURY_PUBLIC_KEY: f.treasury.toBase58(),
            VAULT_PROGRAM_ID: '',
            NEXT_PUBLIC_VAULT_PROGRAM_ID: '',
            ...change,
          },
        }
      );
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (bytes) => (stdout += bytes));
      child.stderr.on('data', (bytes) => (stderr += bytes));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    return { ...output, calls, f };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
test('read-only wallet config registration verifies actual binary Meteora policy without native accounts or program environment', async () => {
  const result = await checkConfig();
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verified, true);
  assert.equal(report.policyVersion, 'bond-v1');
  assert.equal(report.feeCollector, result.f.collector.toBase58());
  assert.equal(report.wroteRegistry, false);
  assert.equal(report.mainnetTradingEnabled, false);
  assert.deepEqual(result.calls, ['getGenesisHash', 'getAccountInfo', 'getGenesisHash']);
  assert(!('custodyProgram' in report));
});
test('independently wrong config digest stops registration without chain or database writes', async () => {
  const result = await checkConfig({ EXPECTED_CONFIG_DIGEST: 'a'.repeat(64) });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(result.calls, ['getGenesisHash', 'getAccountInfo']);
  assert(!result.stderr.includes('http://'));
  assert(result.stderr.includes('No on-chain transaction was sent'));
});
test('active configuration checker accepts bond-v1 public wallet fields without native or external-review blockers', async () => {
  const result = await checkConfig({}, 'audit-launch-config.mjs');
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.policyVersion, 'bond-v1');
  assert.equal(report.economicPolicyMatches, true);
  assert.equal(report.transactionsSigned, 0);
  assert.equal(report.transactionsBroadcast, 0);
  assert.deepEqual(result.calls, ['getGenesisHash', 'getAccountInfo', 'getGenesisHash']);
  assert(!result.stdout.includes('vault behavior'));
  assert(!result.stdout.includes('security sign-off'));
});
