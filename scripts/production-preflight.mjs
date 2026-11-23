import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const app = createRequire(new URL('../scaffolds/fun-launch/package.json', import.meta.url));
const args = process.argv.slice(2);
let pool;
try {
  const { collectProductionPreflight, localInventory, validateExpectations } =
    await import('./production-preflight-core.cjs');
  const { databaseConfig } = await import('./postgres-config.cjs');
  if (args.length === 1 && args[0] === '--inventory') {
    console.log(
      JSON.stringify(
        {
          version: 2,
          policy: 'bond-v1',
          requiresNativeProgram: false,
          offlineInventoryOnly: true,
          readOnly: true,
          financialReleaseReady: false,
          mainnetGateOpened: false,
          inventory: localInventory(),
        },
        null,
        2
      )
    );
  } else {
    let file,
      rehearsal = false,
      databaseReads = false;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (
        arg === '--expect-public' &&
        !file &&
        args[index + 1] &&
        !args[index + 1].startsWith('--')
      )
        file = args[++index];
      else if (arg === '--with-database' && !databaseReads) databaseReads = true;
      else if (arg === '--isolated-rehearsal' && !rehearsal) rehearsal = true;
      else throw new Error('INVALID_ARGUMENT');
    }
    let expected;
    if (file) {
      const location = path.resolve(file),
        stat = fs.lstatSync(location);
      if (
        !location.endsWith('.public.json') ||
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        stat.size > 32 * 1024
      )
        throw new Error('PUBLIC_EXPECTATIONS_FILE_INVALID');
      expected = JSON.parse(fs.readFileSync(location, 'utf8').replace(/^\uFEFF/, ''));
    }
    const inventory = localInventory(),
      validation = validateExpectations(expected, { rehearsal });
    let rpc, contract;
    if (!validation.missing.length && !validation.invalid.length) {
      if (process.env.RPC_URL) {
        const endpoint = new URL(process.env.RPC_URL);
        if (
          endpoint.username ||
          endpoint.password ||
          (!rehearsal && endpoint.protocol !== 'https:')
        )
          throw new Error('RPC_CONFIGURATION_INVALID');
        const { Connection } = app('@solana/web3.js');
        rpc = new Connection(endpoint.href, {
          commitment: 'finalized',
          disableRetryOnRateLimit: true,
          fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15_000) }),
        });
      }
      if (!inventory.schemaContract.missing)
        contract = JSON.parse(
          fs.readFileSync(new URL('./production-schema-contract.json', import.meta.url), 'utf8')
        );
      if (databaseReads && process.env.DATABASE_URL) {
        const { Pool } = app('pg');
        pool = new Pool({
          ...databaseConfig(),
          options: '-c default_transaction_read_only=on',
          application_name: 'rinsed-production-preflight',
        });
        pool.on('error', () => {});
      }
    }
    const result = await collectProductionPreflight({
      expected,
      inventory,
      contract,
      rpc,
      pool,
      rehearsal,
      databaseRequested: databaseReads,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.technicalChecksPassed) process.exitCode = 2;
  }
} catch (error) {
  const allowed = [
    'INVALID_ARGUMENT',
    'PUBLIC_EXPECTATIONS_FILE_INVALID',
    'RPC_CONFIGURATION_INVALID',
  ];
  console.log(
    JSON.stringify(
      {
        version: 2,
        policy: 'wallet-v1',
        requiresNativeProgram: false,
        readOnly: true,
        technicalChecksPassed: false,
        financialReleaseReady: false,
        mainnetGateOpened: false,
        code: allowed.includes(error.message)
          ? error.message
          : 'PREFLIGHT_INPUT_OR_CONFIGURATION_FAILED',
        note: 'Private configuration, provider and database error details are withheld. No signing, broadcast, deployment or database write was requested.',
      },
      null,
      2
    )
  );
  process.exitCode = 1;
} finally {
  await pool?.end().catch(() => {});
}
