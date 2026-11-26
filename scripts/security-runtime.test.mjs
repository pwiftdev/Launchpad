import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const requireApp = createRequire(new URL('../scaffolds/fun-launch/package.json', import.meta.url));

test('the bigint patch cannot load the native converter, even when bindings are available', () => {
  execFileSync(
    process.execPath,
    [
      '-e',
      `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const load = Module._load;
    let attempts = 0;
    Module._load = function(name, parent, ...rest) {
      if (name === 'bindings' && parent?.filename.includes('bigint-buffer')) {
        attempts++;
        throw new Error('Native converter must never load');
      }
      return load.call(this, name, parent, ...rest);
    };
    const {toBigIntLE,toBigIntBE,toBufferLE,toBufferBE} = require('bigint-buffer');
    for (const width of [1,2,8,16,32,64]) {
      const n = (1n << BigInt(width * 8)) - 1n;
      assert.equal(toBigIntLE(toBufferLE(n,width)),n);
      assert.equal(toBigIntBE(toBufferBE(n,width)),n);
    }
    assert.equal(toBigIntLE(Buffer.alloc(0)),0n);
    assert.equal(toBigIntBE(Buffer.from([1,2,3])),0x010203n);
    assert.equal(toBigIntLE(Buffer.from([1,2,3])),0x030201n);
    assert.equal(attempts,0);
  `,
    ],
    { stdio: 'pipe' }
  );
});

test('web3 and the trading SDKs use the JSON RPC client without stream-json server parsers', () => {
  execFileSync(
    process.execPath,
    [
      '-e',
      `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(name, ...rest) {
      if (name === 'stream-json' || name.startsWith('stream-json/'))
        throw new Error('Unreviewed streaming parser entered web runtime');
      return load.call(this,name,...rest);
    };
    const {Connection} = require('@solana/web3.js');
    require('@meteora-ag/dynamic-bonding-curve-sdk');
    require('@meteora-ag/cp-amm-sdk');
    const connection = new Connection('https://rpc.invalid', {fetch: async (_,init) => {
      const request = JSON.parse(init.body);
      assert.equal(request.method,'getVersion');
      return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{'solana-core':'2.3.0','feature-set':1}}), {status:200});
    }});
    connection.getVersion().then(version => {
      assert.equal(version['solana-core'],'2.3.0');
      assert.ok(!Object.keys(require.cache).some(path => /[/\\\\]stream-json[/\\\\]/.test(path)));
    }).catch(error => {console.error(error.name);process.exitCode=1;});
  `,
    ],
    { stdio: 'pipe' }
  );
});

test('the patched Metro consumer reads image buffers through the fixed image-size API', () => {
  const { getAssetSize } = requireApp('metro/private/Assets');
  const png = readFileSync(
    new URL('../scaffolds/fun-launch/public/brand/mskd-favicon-32.png', import.meta.url)
  );
  assert.deepEqual(getAssetSize('png', png, 'favicon.png'), { width: 32, height: 32 });
  assert.throws(() => getAssetSize('png', Buffer.alloc(0), 'empty.png'));
});

test('the fixed TOML parser preserves the Anchor workspace configuration contract', () => {
  const anchorRequire = createRequire(requireApp.resolve('@coral-xyz/anchor'));
  const { parse } = anchorRequire('toml');
  const config = parse(
    '[provider]\ncluster = "localnet"\nwallet = "./operator.json"\n[programs.localnet]\nrinsed_vault = "11111111111111111111111111111111"\n'
  );
  assert.equal(config.provider.cluster, 'localnet');
  assert.equal(config.programs.localnet.rinsed_vault, '11111111111111111111111111111111');
  assert.throws(() => parse(`value = ${'['.repeat(520)}0${']'.repeat(520)}`));
});

test('CSV imports retain Studio and Irys stream options without changing object prototypes', async () => {
  const studioRequire = createRequire(new URL('../studio/package.json', import.meta.url));
  const irysRequire = createRequire(studioRequire.resolve('@irys/upload'));
  for (const loader of [studioRequire, irysRequire]) {
    const { parse } = loader('csv-parse');
    const rows = [];
    const parser = parse({ delimiter: ',', columns: true, skip_empty_lines: true });
    parser.end('path,id,receipt\nlogo.png,example,"{}"\n\n');
    for await (const row of parser) rows.push(row);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].path, 'logo.png');
    assert.equal(rows[0].id, 'example');
    assert.equal(Object.getPrototypeOf(rows[0]), Object.prototype);
    const malicious = parse({ columns: true });
    malicious.end('__proto__,constructor\nvalue,other\n');
    for await (const row of malicious) {
      assert.equal(Object.getPrototypeOf(row), Object.prototype);
      assert.equal(Object.hasOwn(row, '__proto__'), true);
    }
  }
});
