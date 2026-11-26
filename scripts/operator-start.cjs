/* Private wallet-v1 unsigned scheduler. No signer, listener, relay or keypair loader. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { NETWORK_GENESIS } = require('./network-policy.cjs');
const { companyWallets } = require('./company-wallets.cjs');
const { decodeLaunchConfig, inspectLaunchConfig } = require('./launch-policy.cjs');
const { canonical, readSchemaCatalog, compareSchema } = require('./production-schema.cjs');
const contract = require('./production-schema-contract.json');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};
const PRIVATE_ROOT = '/run/secrets/rinsed-operator/';
const EXPORTS = '/var/lib/rinsed-operator/exports';
const FORBIDDEN_ENV =
  /^(?:ADMIN_|WHITELIST_SECRET$|PINATA_JWT$|VAULT_|NEXT_PUBLIC_VAULT_|FINANCIAL_CHECKPOINT_|FINANCIAL_WORKER_ENABLED$|.*PRIVATE_KEY.*|.*SECRET_KEY.*|.*KEYPAIR.*|.*SIGNER_.*|ANCHOR_WALLET$|SOLANA_KEY.*|NODE_OPTIONS$|NODE_PATH$|NODE_TLS_REJECT_UNAUTHORIZED$|NODE_EXTRA_CA_CERTS$|NODE_USE_ENV_PROXY$)/;
function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}
function exact(value, fields) {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !fields.includes(key)) ||
    fields.some((key) => !Object.hasOwn(value, key))
  )
    fail('OPERATOR_CONFIG_FIELDS');
}
function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('OPERATOR_LIMITS');
  return value;
}
function digest(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value) || /^0+$/.test(value))
    fail('OPERATOR_REVIEWED_HASH_REQUIRED');
  return value;
}
function publicKey(value) {
  const { PublicKey } = require('@solana/web3.js');
  try {
    if (
      typeof value !== 'string' ||
      new PublicKey(value).toBase58() !== value ||
      value === PublicKey.default.toBase58()
    )
      fail('OPERATOR_PUBLIC_KEY_REQUIRED');
    return new PublicKey(value);
  } catch {
    return fail('OPERATOR_PUBLIC_KEY_REQUIRED');
  }
}
function validateOperatorConfig(value) {
  exact(value, [
    'version',
    'purpose',
    'reviewed',
    'network',
    'genesis',
    'mainnetTradingEnabled',
    'poolConfigKey',
    'collectorPublicKey',
    'treasuryPublicKey',
    'configSha256',
    'schemaCatalogSha256',
    'artifacts',
    'files',
    'exportsDirectory',
    'scheduler',
    ...(value && Object.hasOwn(value, 'poolPolicyVersion') ? ['poolPolicyVersion'] : []),
    ...(value && Object.hasOwn(value, 'mskdPayout') ? ['mskdPayout'] : []),
  ]);
  if (
    value.version !== 2 ||
    value.purpose !== 'rinsed-private-wallet-operator' ||
    value.reviewed !== true
  )
    fail('OPERATOR_REVIEW_REQUIRED');
  if (
    !Object.hasOwn(NETWORK_GENESIS, value.network) ||
    value.genesis !== NETWORK_GENESIS[value.network]
  )
    fail('OPERATOR_PINNED_NETWORK_REQUIRED');
  if (typeof value.mainnetTradingEnabled !== 'boolean') fail('OPERATOR_MAINNET_CLOSED');
  if (value.network === 'mainnet-beta' && !value.mainnetTradingEnabled)
    fail('OPERATOR_MAINNET_CLOSED');
  if (value.network !== 'mainnet-beta' && value.mainnetTradingEnabled)
    fail('OPERATOR_MAINNET_FLAG_NETWORK');
  if (
    value.poolPolicyVersion !== undefined &&
    ![
      'wallet-v1',
      'bond-v1',
      'mskd-v1',
      'dev-v1',
      'cashback-v1',
      'hsol-v1',
      'cashback-hsol-v1',
      'mskd-hsol-v1',
    ].includes(value.poolPolicyVersion)
  )
    fail('OPERATOR_REVIEWED_CONFIG');
  if (value.mskdPayout !== undefined) {
    exact(value.mskdPayout, ['pool', 'devnetMint']);
    publicKey(value.mskdPayout.pool);
    if (value.network === 'devnet') publicKey(value.mskdPayout.devnetMint);
    else if (value.mskdPayout.devnetMint !== null) fail('OPERATOR_MAINNET_FLAG_NETWORK');
  }
  for (const field of ['poolConfigKey', 'collectorPublicKey', 'treasuryPublicKey'])
    publicKey(value[field]);
  try {
    companyWallets(
      {
        FEE_COLLECTOR_PUBLIC_KEY: value.collectorPublicKey,
        TREASURY_PUBLIC_KEY: value.treasuryPublicKey,
        LAUNCH_POLICY_VERSION: value.poolPolicyVersion,
      },
      value.genesis,
      { allowLegacy: true }
    );
  } catch {
    return fail('OPERATOR_COMPANY_WALLET_PINS');
  }
  for (const field of ['configSha256', 'schemaCatalogSha256']) digest(value[field]);
  if (value.schemaCatalogSha256 !== sha(canonical(contract.catalog)))
    fail('OPERATOR_SCHEMA_PIN_MISMATCH');
  exact(value.artifacts, ['opsSha256', 'schedulerSha256', 'startupSha256']);
  for (const hash of Object.values(value.artifacts)) digest(hash);
  exact(value.files, ['rpcUrl', 'databaseUrl', 'databaseCa']);
  for (const file of Object.values(value.files))
    if (
      typeof file !== 'string' ||
      !file.startsWith(PRIVATE_ROOT) ||
      path.posix.normalize(file) !== file ||
      file.includes('\\') ||
      file.includes('\0')
    )
      fail('OPERATOR_PRIVATE_FILE_PATH');
  if (new Set(Object.values(value.files)).size !== Object.keys(value.files).length)
    fail('OPERATOR_PRIVATE_FILE_PATH');
  if (value.exportsDirectory !== EXPORTS) fail('OPERATOR_EXPORTS_PATH');
  exact(value.scheduler, [
    'cycles',
    'intervalMs',
    'maximumCoins',
    'maximumJobs',
    'maximumRuntimeSeconds',
    'shutdownGraceSeconds',
    'buyback',
  ]);
  integer(value.scheduler.cycles, 1, 1000);
  integer(value.scheduler.intervalMs, 1000, 3600000);
  integer(value.scheduler.maximumCoins, 1, 100);
  integer(value.scheduler.maximumJobs, 1, 100);
  integer(value.scheduler.maximumRuntimeSeconds, 30, 3600);
  integer(value.scheduler.shutdownGraceSeconds, 31, 60);
  if (value.scheduler.buyback !== null) {
    exact(value.scheduler.buyback, ['maximumSpendLamports', 'maximumSlippageBps']);
    if (
      typeof value.scheduler.buyback.maximumSpendLamports !== 'string' ||
      !/^\d{1,20}$/.test(value.scheduler.buyback.maximumSpendLamports) ||
      BigInt(value.scheduler.buyback.maximumSpendLamports) <= 0n ||
      BigInt(value.scheduler.buyback.maximumSpendLamports) > 18446744073709551615n
    )
      fail('OPERATOR_BUYBACK_LIMIT');
    integer(value.scheduler.buyback.maximumSlippageBps, 1, 100);
  }
  return structuredClone(value);
}

function boundedRegularFile(
  file,
  { io = fs, uid = process.getuid?.(), sensitive = true, root = PRIVATE_ROOT, maximum = 65536 } = {}
) {
  let fd;
  const identity = (stat) =>
    [
      'dev',
      'ino',
      'uid',
      'gid',
      'mode',
      'size',
      'nlink',
      stat.mtimeNs === undefined ? 'mtimeMs' : 'mtimeNs',
      stat.ctimeNs === undefined ? 'ctimeMs' : 'ctimeNs',
    ]
      .map((name) => String(stat[name]))
      .join(':');
  const regular = (stat) => {
    if (
      !stat.isFile() ||
      stat.isSymbolicLink?.() ||
      BigInt(stat.size) > BigInt(maximum) ||
      (sensitive && ((Number(stat.mode) & 0o077) !== 0 || Number(stat.uid) !== uid))
    )
      fail('OPERATOR_PRIVATE_FILE_PERMISSIONS');
  };
  try {
    const before = io.lstatSync(file, { bigint: true });
    regular(before);
    const resolved = io.realpathSync(file);
    if (root && !resolved.startsWith(root)) fail('OPERATOR_PRIVATE_FILE_PERMISSIONS');
    fd = io.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0)
    );
    const opened = io.fstatSync(fd, { bigint: true });
    regular(opened);
    if (identity(before) !== identity(opened)) fail('OPERATOR_PRIVATE_FILE_CHANGED');
    const bytes = Buffer.alloc(maximum + 1);
    let total = 0;
    for (;;) {
      const count = io.readSync(fd, bytes, total, bytes.length - total, total);
      if (count === 0) break;
      total += count;
      if (total > maximum) fail('OPERATOR_PRIVATE_FILE_CAPACITY');
    }
    const after = io.fstatSync(fd, { bigint: true }),
      current = io.lstatSync(file, { bigint: true });
    regular(after);
    regular(current);
    if (
      identity(opened) !== identity(after) ||
      identity(after) !== identity(current) ||
      total !== Number(after.size) ||
      io.realpathSync(file) !== resolved
    )
      fail('OPERATOR_PRIVATE_FILE_CHANGED');
    if (bytes.subarray(0, total).includes(0)) fail('OPERATOR_PRIVATE_FILE_FORMAT');
    return bytes.subarray(0, total);
  } catch (error) {
    if (error?.code?.startsWith('OPERATOR_')) throw error;
    return fail('OPERATOR_PRIVATE_FILE_UNAVAILABLE');
  } finally {
    if (fd !== undefined) io.closeSync(fd);
  }
}
function privateFile(file, io = fs, uid = process.getuid?.(), sensitive = true) {
  return boundedRegularFile(file, { io, uid, sensitive }).toString('utf8').trim();
}
function readOperatorConfigFile(file, io = fs) {
  return boundedRegularFile(file, { io, sensitive: false, root: null, maximum: 16384 });
}

function verifyOperatorArtifacts(config, directory = __dirname) {
  for (const [file, expected] of [
    ['ops.cjs', config.artifacts.opsSha256],
    ['scheduler.cjs', config.artifacts.schedulerSha256],
    ['operator-start.cjs', config.artifacts.startupSha256],
  ]) {
    if (sha(fs.readFileSync(path.join(directory, file))) !== expected)
      fail('OPERATOR_ARTIFACT_PIN_MISMATCH');
  }
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, 'runtime-manifest.json'), 'utf8')
  );
  if (
    manifest.version !== 2 ||
    manifest.policy !== 'wallet-v1' ||
    !manifest.dependencyTreeAbsent ||
    !manifest.globalModuleSearchDisabled ||
    !manifest.isolatedDryRunsPassed ||
    manifest.signaturesCreated !== 0 ||
    manifest.transactionsSent !== 0 ||
    manifest.files['ops.cjs'] !== config.artifacts.opsSha256 ||
    manifest.files['scheduler.cjs'] !== config.artifacts.schedulerSha256
  )
    fail('OPERATOR_RUNTIME_EVIDENCE_REQUIRED');
  const packaged = JSON.parse(
    fs.readFileSync(path.join(directory, 'private-package-manifest.json'), 'utf8')
  );
  if (
    packaged.version !== 2 ||
    packaged.policy !== 'wallet-v1' ||
    packaged.nodeMajor !== 24 ||
    packaged.pnpm !== '10.27.0' ||
    packaged.containsSigner !== false ||
    packaged.unsignedSchedulerOnly !== true ||
    packaged.startupOutsideCheckoutHelpPassed !== true ||
    packaged.globalModuleSearchDisabled !== true ||
    packaged.files['ops.cjs'] !== config.artifacts.opsSha256 ||
    packaged.files['scheduler.cjs'] !== config.artifacts.schedulerSha256 ||
    packaged.files['operator-start.cjs'] !== config.artifacts.startupSha256
  )
    fail('OPERATOR_PRIVATE_PACKAGE_EVIDENCE_REQUIRED');
}

async function superviseUnsignedScheduler(
  config,
  env,
  {
    spawnImpl = spawn,
    signals = process,
    directory = __dirname,
    timers = { setTimeout, clearTimeout },
  } = {}
) {
  const child = spawnImpl(
    process.execPath,
    [
      '--no-global-search-paths',
      path.join(directory, 'scheduler.cjs'),
      ...schedulerArguments(config),
    ],
    {
      cwd: directory,
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: false,
      windowsHide: true,
    }
  );
  let stopping = false,
    timedOut = false,
    forceTimer;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child.kill('SIGTERM');
    forceTimer = timers.setTimeout(
      () => child.kill('SIGKILL'),
      config.scheduler.shutdownGraceSeconds * 1000
    );
    forceTimer.unref?.();
  };
  const deadline = timers.setTimeout(() => {
    timedOut = true;
    stop();
  }, config.scheduler.maximumRuntimeSeconds * 1000);
  deadline.unref?.();
  signals.on('SIGINT', stop);
  signals.on('SIGTERM', stop);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', () =>
        reject(Object.assign(new Error('OPERATOR_CHILD_FAILED'), { code: 'OPERATOR_CHILD_FAILED' }))
      );
      child.once('exit', (code, signal) =>
        resolve(timedOut ? 124 : stopping ? 143 : code === 0 && !signal ? 0 : 1)
      );
    });
  } finally {
    timers.clearTimeout(deadline);
    if (forceTimer) timers.clearTimeout(forceTimer);
    signals.removeListener('SIGINT', stop);
    signals.removeListener('SIGTERM', stop);
  }
}

function loadOperatorEnvironment(
  config,
  { io = fs, uid = process.getuid?.(), inherited = process.env } = {}
) {
  for (const [key, value] of Object.entries(inherited))
    if (value && FORBIDDEN_ENV.test(key)) fail('OPERATOR_MIXED_OR_UNSAFE_ENVIRONMENT');
  const read = (name, sensitive = true) => privateFile(config.files[name], io, uid, sensitive);
  const rpc = read('rpcUrl'),
    database = read('databaseUrl');
  let rpcUrl, databaseUrl;
  try {
    rpcUrl = new URL(rpc);
    databaseUrl = new URL(database);
  } catch {
    return fail('OPERATOR_SECRET_FORMAT');
  }
  if (rpcUrl.protocol !== 'https:' || rpcUrl.username || rpcUrl.password || rpcUrl.hash)
    fail('OPERATOR_RPC_HTTPS_REQUIRED');
  if (
    !['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
    !databaseUrl.hostname ||
    !databaseUrl.username ||
    !databaseUrl.password ||
    databaseUrl.pathname.length < 2 ||
    databaseUrl.hash ||
    [...databaseUrl.searchParams.keys()].some((name) => name !== 'sslmode')
  )
    fail('OPERATOR_DATABASE_SETTINGS');
  if (!read('databaseCa', false).includes('-----BEGIN CERTIFICATE-----'))
    fail('OPERATOR_DATABASE_CA_REQUIRED');
  let exports;
  try {
    exports = io.statSync(config.exportsDirectory);
    if (io.realpathSync(config.exportsDirectory) !== config.exportsDirectory)
      fail('OPERATOR_EXPORTS_PERMISSIONS');
    io.accessSync(config.exportsDirectory, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    return fail('OPERATOR_EXPORTS_PERMISSIONS');
  }
  if (!exports.isDirectory() || exports.uid !== uid || (exports.mode & 0o077) !== 0)
    fail('OPERATOR_EXPORTS_PERMISSIONS');
  return {
    NODE_ENV: 'production',
    NEXT_PUBLIC_NETWORK: config.network,
    RPC_URL: rpc,
    DATABASE_URL: database,
    DATABASE_SSL_CA: config.files.databaseCa,
    POOL_CONFIG_KEY: config.poolConfigKey,
    NEXT_PUBLIC_POOL_CONFIG_KEY: config.poolConfigKey,
    FEE_COLLECTOR_PUBLIC_KEY: config.collectorPublicKey,
    TREASURY_PUBLIC_KEY: config.treasuryPublicKey,
    WALLET_WORKER_ENABLED: 'true',
    MAINNET_TRADING_ENABLED: config.mainnetTradingEnabled ? 'true' : 'false',
    ...(config.poolPolicyVersion ? { LAUNCH_POLICY_VERSION: config.poolPolicyVersion } : {}),
    ...(config.mskdPayout
      ? {
          MSKD_PAYOUT_POOL: config.mskdPayout.pool,
          ...(config.mskdPayout.devnetMint
            ? { MSKD_DEVNET_PAYOUT_MINT: config.mskdPayout.devnetMint }
            : {}),
        }
      : {}),
  };
}
async function probeOperatorDeployment(
  config,
  env,
  { rpc: suppliedRpc, pool: suppliedPool, readCatalog = readSchemaCatalog } = {}
) {
  const { Connection, PublicKey } = require('@solana/web3.js');
  const key = publicKey(config.poolConfigKey);
  const rpc =
    suppliedRpc ??
    new Connection(env.RPC_URL, {
      commitment: 'finalized',
      disableRetryOnRateLimit: true,
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10000) }),
    });
  if ((await rpc.getGenesisHash()) !== config.genesis) fail('OPERATOR_NETWORK_MISMATCH');
  const account = await rpc.getAccountInfo(key, 'finalized');
  if (
    !account ||
    account.executable ||
    !account.owner.equals(new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')) ||
    sha(account.data) !== config.configSha256
  )
    fail('OPERATOR_REVIEWED_CONFIG');
  let economicPolicy;
  try {
    const decoded = decodeLaunchConfig(account.data);
    economicPolicy =
      config.poolPolicyVersion ?? (decoded.activationType === 0 ? 'bond-v1' : 'wallet-v1');
    if (economicPolicy === 'bond-v1')
      companyWallets(
        {
          FEE_COLLECTOR_PUBLIC_KEY: config.collectorPublicKey,
          TREASURY_PUBLIC_KEY: config.treasuryPublicKey,
        },
        config.genesis
      );
    if (
      inspectLaunchConfig(decoded, {
        feeClaimer: config.collectorPublicKey,
        leftoverReceiver: config.treasuryPublicKey,
        policyVersion: economicPolicy,
      }).length
    )
      fail('OPERATOR_REVIEWED_CONFIG');
  } catch {
    return fail('OPERATOR_REVIEWED_CONFIG');
  }
  const { Pool } = require('pg'),
    { databaseConfig } = require('./postgres-config.cjs');
  const pool =
    suppliedPool ??
    new Pool({ ...databaseConfig(env), max: 1, application_name: 'rinsed-private-wallet-start' });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout='5000ms'");
    if (
      (await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0]
        ?.ssl !== true
    )
      fail('OPERATOR_DATABASE_TLS_REQUIRED');
    if (compareSchema(contract.catalog, await readCatalog(client)).length)
      fail('OPERATOR_DATABASE_SCHEMA_MISMATCH');
    const row = (
      await client.query(
        'SELECT * FROM launch_configs WHERE network_genesis=$1 AND config_key=$2',
        [config.genesis, config.poolConfigKey]
      )
    ).rows[0];
    if (
      !row?.enabled_for_launch ||
      row.policy_version !== economicPolicy ||
      row.config_digest !== config.configSha256 ||
      row.expected_fee_claimer !== config.collectorPublicKey ||
      row.expected_leftover_receiver !== config.treasuryPublicKey
    )
      fail('OPERATOR_DATABASE_CONFIG_MISMATCH');
    if ((await rpc.getGenesisHash()) !== config.genesis)
      fail('OPERATOR_NETWORK_CHANGED_DURING_STARTUP');
    await client.query('ROLLBACK');
  } finally {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    if (!suppliedPool) await pool.end();
  }
  return {
    networkVerified: true,
    reviewedWalletConfigVerified: true,
    databaseTlsSchemaVerified: true,
    requiresNativeProgram: false,
  };
}
function schedulerArguments(config) {
  const s = config.scheduler;
  return [
    '--execute',
    '--cycles',
    String(s.cycles),
    '--interval-ms',
    String(s.intervalMs),
    '--maximum-coins',
    String(s.maximumCoins),
    '--maximum-jobs',
    String(s.maximumJobs),
    ...(s.buyback
      ? [
          '--max-spend-lamports',
          s.buyback.maximumSpendLamports,
          '--slippage-bps',
          String(s.buyback.maximumSlippageBps),
        ]
      : []),
  ];
}
async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help')
    return console.log(
      'Private unsigned wallet scheduler: --config /run/config/rinsed-operator.json [--check]. No signer, listener or native program. Mainnet is disabled in the example configuration.'
    );
  if (
    args.length < 2 ||
    args[0] !== '--config' ||
    !path.isAbsolute(args[1]) ||
    (args.length > 2 && (args.length !== 3 || args[2] !== '--check'))
  )
    fail('OPERATOR_CONFIG_ARGUMENT');
  if (
    process.platform !== 'linux' ||
    process.getuid?.() === 0 ||
    Number(process.versions.node.split('.')[0]) !== 24
  )
    fail('OPERATOR_LINUX_NONROOT_NODE24_REQUIRED');
  const config = validateOperatorConfig(
      JSON.parse(readOperatorConfigFile(args[1]).toString('utf8'))
    ),
    env = loadOperatorEnvironment(config);
  verifyOperatorArtifacts(config);
  const report = await probeOperatorDeployment(config, env);
  if (args[2] === '--check')
    return console.log(
      JSON.stringify({
        ok: true,
        unsignedOnly: true,
        automaticSigning: false,
        mainnetTradingEnabled: config.mainnetTradingEnabled,
        ...report,
      })
    );
  process.exitCode = await superviseUnsignedScheduler(config, env);
}
module.exports = {
  validateOperatorConfig,
  boundedRegularFile,
  readOperatorConfigFile,
  privateFile,
  loadOperatorEnvironment,
  verifyOperatorArtifacts,
  probeOperatorDeployment,
  schedulerArguments,
  superviseUnsignedScheduler,
  main,
  schemaCatalogSha256: sha(canonical(contract.catalog)),
};
if (require.main === module)
  main().catch((error) => {
    console.error(
      JSON.stringify({
        ok: false,
        code:
          typeof error.code === 'string' && /^OPERATOR_[A-Z0-9_]+$/.test(error.code)
            ? error.code
            : 'OPERATOR_START_FAILED',
        note: 'Private startup stopped; configuration values and provider errors are withheld.',
      })
    );
    process.exitCode = 1;
  });
