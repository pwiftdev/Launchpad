import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildWebEnvironmentValidator } from './build-web-env.mjs';
const execute = promisify(execFile),
  owner = createRequire(import.meta.url)('../docs/mainnet-authorities.public.json');
test('web environment validation is dependency-independent outside the checkout and keeps signer settings out', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'rinsed-web-env-'));
  try {
    const artifact = path.join(folder, 'validate-env.cjs');
    await buildWebEnvironmentValidator(artifact);
    const source = await readFile(artifact, 'utf8');
    assert.ok(source.length > 1000);
    const env = {
      RPC_URL: 'https://provider.invalid/?key=DO_NOT_DISCLOSE',
      POOL_CONFIG_KEY: '11111111111111111111111111111111',
      PINATA_JWT: 'DO_NOT_DISCLOSE',
      NEXT_PUBLIC_NETWORK: 'devnet',
      NEXT_PUBLIC_SITE_URL: 'https://launch.example',
      FEE_COLLECTOR_PUBLIC_KEY: owner.company.collector,
      TREASURY_PUBLIC_KEY: owner.vault.treasury,
      DATABASE_URL: 'postgres://fixture:DO_NOT_DISCLOSE@db.invalid/app',
      WALLET_WORKER_ENABLED: 'false',
    };
    const options = {
      cwd: folder,
      env: {
        PATH: path.dirname(process.execPath),
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
      },
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    };
    const run = (input) =>
      execute(
        process.execPath,
        [
          '--no-global-search-paths',
          '-e',
          "require('./validate-env.cjs').validateEnv(JSON.parse(process.argv[1]));console.log('validated')",
          JSON.stringify(input),
        ],
        options
      );
    const result = await run(env);
    assert.equal(result.stdout.trim(), 'validated');
    assert.doesNotMatch(result.stdout + result.stderr, /DO_NOT_DISCLOSE/);
    await assert.rejects(
      run({ ...env, WALLET_SIGNER_KEYPAIR_FILE: '/private/key.json' }),
      (error) => {
        assert.match(error.stderr, /separate private signer/);
        assert.doesNotMatch(error.stderr, /DO_NOT_DISCLOSE/);
        return true;
      }
    );
  } finally {
    assert.equal(path.dirname(folder), path.resolve(os.tmpdir()));
    assert.ok(path.basename(folder).startsWith('rinsed-web-env-'));
    await rm(folder, { recursive: true, force: true });
  }
});
