// Execute portable operator bundles outside the checkout, with no dependency tree or credentials.
import { createServer } from 'node:http';
import { mkdtemp, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const artifact = path.join(root, 'scaffolds/fun-launch/.worker');
const folder = await mkdtemp(path.join(tmpdir(), 'rinsed-operator-smoke-'));
const genesis = '6XteJMST5Y9WCy3vazr8kmxVDHtoTDZwURRVjQQDPxL2';
const mint = '11111111111111111111111111111111';
const authorities = JSON.parse(
  await readFile(new URL('../docs/mainnet-authorities.public.json', import.meta.url), 'utf8')
);
const methods = [];
const rpc = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16384) {
      response.writeHead(413).end();
      return;
    }
  }
  const message = JSON.parse(body);
  methods.push(message.method);
  response.setHeader('content-type', 'application/json');
  response.end(
    JSON.stringify(
      message.method === 'getGenesisHash'
        ? { jsonrpc: '2.0', id: message.id, result: genesis }
        : {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Read-only smoke method only' },
          }
    )
  );
});
try {
  const hashes = {};
  for (const name of ['ops.cjs', 'scheduler.cjs', 'wallet-signer.cjs']) {
    const bytes = await readFile(path.join(artifact, name));
    assert.ok(bytes.length < 50 * 1024 * 1024);
    hashes[name] = createHash('sha256').update(bytes).digest('hex');
    await copyFile(path.join(artifact, name), path.join(folder, name));
  }
  await new Promise((resolve) => rpc.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${rpc.address().port}`;
  const env = {
    PATH: path.dirname(process.execPath),
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: folder,
    TMP: folder,
    NODE_OPTIONS: '',
    NODE_PATH: '',
    NODE_ENV: 'development',
    NEXT_PUBLIC_NETWORK: 'localnet',
    LOCAL_VALIDATOR_ENABLED: 'true',
    LOCAL_VALIDATOR_GENESIS_HASH: genesis,
    RPC_URL: endpoint,
    NEXT_PUBLIC_LOCAL_VALIDATOR_RPC_URL: endpoint,
    NEXT_PUBLIC_SITE_URL: endpoint,
    FEE_COLLECTOR_PUBLIC_KEY: authorities.company.collector,
    TREASURY_PUBLIC_KEY: authorities.vault.treasury,
    WALLET_WORKER_ENABLED: 'false',
    MAINNET_TRADING_ENABLED: 'false',
  };
  for (const name of ['ops.cjs', 'scheduler.cjs', 'wallet-signer.cjs']) {
    const run = (args) =>
      execute(process.execPath, ['--no-global-search-paths', path.join(folder, name), ...args], {
        cwd: folder,
        env,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
    const help = await run(['--help']);
    assert.match(
      help.stdout,
      name === 'ops.cjs'
        ? /Wallet operations:/
        : name === 'scheduler.cjs'
          ? /Wallet operations:/
          : /Company-wallet sign-only process:/
    );
    if (name === 'wallet-signer.cjs') continue;
    const output = await run(name === 'ops.cjs' ? ['status', '--mint', mint] : []);
    const result = JSON.parse(output.stdout);
    assert.equal(result.dryRun, true);
    assert.equal(result.transactionsSigned, false);
    assert.equal(result.transactionsSent, false);
  }
  assert.deepEqual(methods, ['getGenesisHash', 'getGenesisHash']);
  const manifest = {
    version: 2,
    policy: 'wallet-v1',
    requiresNativeProgram: false,
    checkedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    files: hashes,
    dependencyTreeAbsent: true,
    globalModuleSearchDisabled: true,
    isolatedDryRunsPassed: true,
    rpcMethods: methods,
    signaturesCreated: 0,
    transactionsSent: 0,
    note: 'Portable runtime evidence only. No production configuration, keys, custody acceptance or release approval.',
  };
  await writeFile(
    path.join(artifact, 'runtime-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
  console.log(JSON.stringify(manifest, null, 2));
} finally {
  rpc.closeAllConnections();
  await new Promise((resolve) => rpc.close(resolve));
  if (
    path.dirname(folder) !== path.resolve(tmpdir()) ||
    !path.basename(folder).startsWith('rinsed-operator-smoke-')
  )
    throw new Error('Unsafe operator smoke directory');
  await rm(folder, { recursive: true, force: true });
}
