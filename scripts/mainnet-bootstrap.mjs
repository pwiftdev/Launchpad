/* Never signs, sends, deploys, generates keys, or opens a release gate. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const cliArgs = process.argv.slice(2);
if (cliArgs.length === 1 && cliArgs[0] === '--help') {
  console.log(`Mainnet bootstrap: read-only checks and unsigned preparation only.

Estimate fresh program/native-account rent:
  node scripts/mainnet-bootstrap.mjs --estimate --elf REVIEWED.so --elf-sha256 REVIEWED_SHA256 --connection-file .local/mainnet-connection.private.json --output .local/rent.private.json

Prepare one atomic initialize/unpause -> approve config -> pause transaction:
  node scripts/mainnet-bootstrap.mjs --prepare --elf REVIEWED.so --review-public REVIEWED.public.json --connection-file .local/mainnet-connection.private.json --output .local/bootstrap.private.json

Required in both modes: --elf, --connection-file, --output.
Estimate also requires --elf-sha256, or --review-public containing program.elfSha256.
Estimate optionally accepts --max-data-length BYTES for explicit upgrade headroom; default is reviewed ELF length. Rent excludes transaction fees and DBC config creation.
Prepare requires --review-public with independently reviewed version:1, networkGenesis, program:{address,upgradeAuthority,elfSha256,deployedDataSha256}, config:{address,digest}. It refuses missing pins and does not learn expected values from RPC observations.
Owner roles always come from docs/mainnet-authorities.public.json.
Connection input must be an ignored .local/*.private.json containing HTTPS rpcUrl and expectedGenesis. No wallet key input is accepted.
Output must be a NEW ignored .local/*.private.json; existing files are never overwritten. Unsigned transaction bytes and public recovery context stay in that file; stdout contains only a result summary. Final planned vault state stays paused.
Signatures created: 0. Transactions sent: 0. No signing, deployment, key generation, database writes, or release-gate changes. Intended addresses do not prove signer custody.
--help makes no RPC calls, reads no private inputs or ELF, and writes no files.`);
} else {
  const {
    authorities,
    estimateBootstrap,
    prepareBootstrap,
    MAINNET,
    BootstrapError,
    redactBootstrapError,
    readOnlyRpcFetch,
    readBoundedFile,
  } = await import('./mainnet-bootstrap-core.cjs');
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    local = path.join(workspace, '.local'),
    app = createRequire(new URL('../scaffolds/fun-launch/package.json', import.meta.url));
  function readJson(filename, maxBytes = 32768) {
    return JSON.parse(
      readBoundedFile(filename, maxBytes)
        .toString('utf8')
        .replace(/^\uFEFF/, '')
    );
  }
  function privatePath(filename) {
    const location = path.resolve(filename),
      relative = path.relative(local, location);
    if (
      !relative ||
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      !location.endsWith('.private.json')
    )
      throw new BootstrapError('PRIVATE_LOCAL_OUTPUT_REQUIRED');
    let cursor = path.dirname(location);
    while (path.relative(workspace, cursor) !== '') {
      const stat = fs.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new BootstrapError('OUTPUT_PARENT_INVALID');
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new BootstrapError('OUTPUT_PARENT_INVALID');
      cursor = parent;
    }
    return location;
  }
  try {
    const args = process.argv.slice(2),
      options = {};
    let mode;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--estimate' || arg === '--prepare') {
        if (mode) throw new BootstrapError('INVALID_ARGUMENT');
        mode = arg.slice(2);
        continue;
      }
      if (
        ![
          '--review-public',
          '--elf',
          '--elf-sha256',
          '--max-data-length',
          '--connection-file',
          '--output',
        ].includes(arg) ||
        options[arg] !== undefined ||
        !args[i + 1] ||
        args[i + 1].startsWith('--')
      )
        throw new BootstrapError('INVALID_ARGUMENT');
      options[arg] = args[++i];
    }
    if (!mode || !options['--elf'] || !options['--connection-file'] || !options['--output'])
      throw new BootstrapError('REQUIRED_INPUTS_MISSING');
    if (mode === 'prepare' && (options['--elf-sha256'] || options['--max-data-length']))
      throw new BootstrapError('PREPARE_USES_REVIEWED_PROGRAM_PINS');
    const output = privatePath(options['--output']);
    if (fs.existsSync(output)) throw new BootstrapError('OUTPUT_ALREADY_EXISTS');
    const owner = readJson(path.join(workspace, 'docs/mainnet-authorities.public.json'));
    authorities(owner);
    if (options['--review-public'] && !options['--review-public'].endsWith('.public.json'))
      throw new BootstrapError('PUBLIC_REVIEW_FILE_REQUIRED');
    const review = options['--review-public'] ? readJson(options['--review-public']) : undefined;
    if (mode === 'prepare' && !review)
      throw new BootstrapError('INDEPENDENT_PROGRAM_AND_CONFIG_PINS_REQUIRED');
    const elf = readBoundedFile(options['--elf'], 10 * 1024 * 1024);
    const config = readJson(privatePath(options['--connection-file']));
    if (
      config.expectedGenesis !== MAINNET ||
      typeof config.rpcUrl !== 'string' ||
      Object.keys(config).some(
        (key) =>
          !['rpcUrl', 'expectedGenesis', 'purpose', 'financialExecutionEnabled'].includes(key)
      ) ||
      (config.financialExecutionEnabled !== undefined &&
        config.financialExecutionEnabled !== false) ||
      (config.purpose !== undefined &&
        (typeof config.purpose !== 'string' || config.purpose.length > 256))
    )
      throw new BootstrapError('MAINNET_CONNECTION_INVALID');
    const url = new URL(config.rpcUrl);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new BootstrapError('MAINNET_CONNECTION_INVALID');
    const { Connection } = app('@solana/web3.js');
    const rpc = new Connection(url.href, {
      commitment: 'finalized',
      disableRetryOnRateLimit: true,
      fetch: readOnlyRpcFetch(),
    });
    const result =
      mode === 'estimate'
        ? await estimateBootstrap({
            rpc,
            owner,
            elf,
            elfSha256: options['--elf-sha256'] ?? review?.program?.elfSha256,
            maxDataLength:
              options['--max-data-length'] === undefined
                ? undefined
                : Number(options['--max-data-length']),
          })
        : await prepareBootstrap({ rpc, owner, review, elf });
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(
      JSON.stringify({
        ok: true,
        mode,
        status: result.status ?? 'rent-estimate-only',
        output: path.relative(workspace, output).replaceAll('\\', '/'),
        unsignedTransactions: result.transactions?.length ?? 0,
        financialReleaseReady: false,
        mainnetGateOpened: false,
        signaturesCreated: 0,
        transactionsBroadcast: 0,
      })
    );
  } catch (error) {
    const code = redactBootstrapError(error);
    console.log(
      JSON.stringify({
        ok: false,
        code,
        unsignedOnly: true,
        financialReleaseReady: false,
        mainnetGateOpened: false,
        signaturesCreated: 0,
        transactionsBroadcast: 0,
        note: 'No signing, sending, deployment, or key generation was requested. Provider URLs and private input details are withheld.',
      })
    );
    process.exitCode = 1;
  }
}
