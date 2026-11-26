'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto'),
  { spawn } = require('node:child_process');
const ROOT = __dirname,
  KEY_ENV = 'WALLET_SIGNER_SECRET_KEY_JSON',
  LEGACY_KEY_ENV = 'LEGACY_WALLET_SIGNER_SECRET_KEY_JSON';
const PINS = {
  configKey: '2VN1TJVDbw8bxmMTJye8xzdTxVa93Uh8FUSt3UqGcqZ6',
  configDigest: '2fe8bacae26806bb3bf3aba4cb51332593181da9ba927f6c60b16b2856835f21',
  collector: '3j4vUdPKF7HNqKoaWdezQoX9Hognn6Us7ua6thZZiaed',
  collectorHex: '287e33d4694a65a5854b3d31061a62d6b2757e101f436eaf91ed92013b8cf112',
  treasury: 'GfgpgQa2ZqNm17rJ6fw2t5nBApKKPZBn5M5niWW3riZZ',
  legacyConfigKey: '3FPuMxbaagtAn45zvufthsLkZnSenTPta7nuY7ZVshsE',
  legacyCollector: '5iskTyXpKn7HeqvNUFBFc1rv2C2EoFNBNyFmXgGFztgS',
};
const DEV_PINS = {
  configKey: '56pQWoQgHcAu5Cykb6cEVQ3ifcxFhFyjQcVwe26XsMn',
  configDigest: 'ed011260cbce54c2097b16d38e2889d7086e51336099bbd7761c3cbc388a529e',
  collector: 'FiFmAXm5cTx1sCH5zSUpBbDFt9rVgCfuGhMVahDWLmHm',
  collectorHex: 'da951ef7e3067f8d2dbab5c73ffc0d56ed6433042184877d04c6595e8fde45c4',
  treasury: 'GHCkJgsWsy5PGZHQuwoJtBv6BgyQQB7FA8KgRStyoqwH',
};
const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const REWARD_ENVIRONMENT = [
  'MAINNET_CASHBACK_CONFIG_KEY',
  'MAINNET_MSKD_CONFIG_KEY',
  'MAINNET_HSOL_CONFIG_KEY',
  'MAINNET_CASHBACK_HSOL_CONFIG_KEY',
  'MAINNET_MSKD_HSOL_CONFIG_KEY',
  'MSKD_PAYOUT_POOL',
];

function rewardEnvironment(manifest, env) {
  const values = Object.fromEntries(
    REWARD_ENVIRONMENT.filter((key) => env[key]).map((key) => [key, env[key]])
  );
  if (
    (Object.keys(values).length && manifest.policyVersion !== 'dev-v1') ||
    Object.values(values).some((key) => !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key)) ||
    Boolean(values.MAINNET_MSKD_CONFIG_KEY) !== Boolean(values.MSKD_PAYOUT_POOL) ||
    new Set([manifest.configKey, ...Object.values(values)]).size !== Object.keys(values).length + 1
  )
    fail('PRIVATE_WORKER_REWARD_CONFIG_INVALID');
  return values;
}
function boundedFile(file, maximum) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum)
    fail('PACKAGE_FILE_INVALID');
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0)
  );
  try {
    const current = fs.fstatSync(fd);
    if (current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size)
      fail('PACKAGE_FILE_CHANGED');
    const bytes = Buffer.alloc(maximum + 1);
    let n = 0;
    while (n < bytes.length) {
      const read = fs.readSync(fd, bytes, n, bytes.length - n, null);
      if (!read) break;
      n += read;
    }
    const after = fs.fstatSync(fd),
      last = fs.lstatSync(file);
    if (
      n !== before.size ||
      n > maximum ||
      [after, last].some(
        (value) =>
          !value.isFile() ||
          value.dev !== before.dev ||
          value.ino !== before.ino ||
          value.size !== before.size ||
          value.mtimeMs !== before.mtimeMs ||
          value.ctimeMs !== before.ctimeMs
      )
    )
      fail('PACKAGE_FILE_CHANGED');
    return bytes.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}
function verifyPackage() {
  const manifest = JSON.parse(boundedFile(path.join(ROOT, 'manifest.json'), 65536));
  const required = [
    'bootstrap.cjs',
    'package.json',
    'Procfile',
    'rds-ca.crt',
    'artifacts/ops.cjs',
    'artifacts/scheduler.cjs',
    'artifacts/wallet-signer.cjs',
  ];
  if (JSON.stringify(Object.keys(manifest.files || {}).sort()) !== JSON.stringify(required.sort()))
    fail('PACKAGE_FILE_SET_INVALID');
  if (
    manifest.version !== 1 ||
    manifest.role !== 'rinsed-private-wallet-worker' ||
    manifest.publicListeners !== 0 ||
    manifest.defaultAutomatic !== false
  )
    fail('PACKAGE_ROLE_INVALID');
  for (const [file, expected] of Object.entries(manifest.files)) {
    if (
      !/^(?:bootstrap\.cjs|package\.json|Procfile|rds-ca\.crt|artifacts\/(?:ops|scheduler|wallet-signer)\.cjs)$/.test(
        file
      ) ||
      !/^[a-f0-9]{64}$/.test(expected) ||
      digest(boundedFile(path.join(ROOT, file), 12 * 1024 * 1024)) !== expected
    )
      fail('PACKAGE_HASH_MISMATCH');
  }
  const pins = manifest.policyVersion === 'dev-v1' ? DEV_PINS : PINS;
  if (
    (manifest.policyVersion !== undefined && manifest.policyVersion !== 'dev-v1') ||
    manifest.genesis !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' ||
    manifest.configKey !== pins.configKey ||
    manifest.configDigest !== pins.configDigest ||
    manifest.collector !== pins.collector ||
    manifest.collectorHex !== pins.collectorHex ||
    manifest.treasury !== pins.treasury
  )
    fail('PACKAGE_MAINNET_PINS_INVALID');
  return manifest;
}
function integer(env, key, fallback, min, max) {
  const raw = env[key];
  if (raw !== undefined && !/^\d+$/.test(raw)) fail('WORKER_LIMIT_INVALID');
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('WORKER_LIMIT_INVALID');
  return value;
}
function money(value, required) {
  if (value === undefined || value === '') {
    if (required) fail('SIGNER_LIMIT_REQUIRED');
    return undefined;
  }
  if (!/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > 18446744073709551615n)
    fail('SIGNER_LIMIT_INVALID');
  return value;
}
function configuration(manifest, env) {
  if (
    env.WALLET_PRIVATE_WORKER !== 'true' ||
    env.WALLET_WORKER_ENABLED !== 'true' ||
    env.NEXT_PUBLIC_NETWORK !== 'mainnet-beta' ||
    env.MAINNET_TRADING_ENABLED !== 'true' ||
    env.POOL_CONFIG_KEY !== manifest.configKey ||
    env.WALLET_CONFIG_SHA256 !== manifest.configDigest ||
    env.FEE_COLLECTOR_PUBLIC_KEY !== manifest.collector ||
    env.TREASURY_PUBLIC_KEY !== manifest.treasury ||
    (manifest.policyVersion && env.LAUNCH_POLICY_VERSION !== manifest.policyVersion)
  )
    fail('PRIVATE_WORKER_REVIEWED_CONFIG_REQUIRED');
  if ((env.DYNO && !/^worker\.\d+$/.test(env.DYNO)) || env.HEROKU_APP_NAME === 'rinsed-launchpad')
    fail('PRIVATE_WORKER_ROLE_REQUIRED');
  if (
    env.WALLET_AUTOMATIC_ENABLED !== undefined &&
    !['false', 'true'].includes(env.WALLET_AUTOMATIC_ENABLED)
  )
    fail('AUTOMATIC_FLAG_INVALID');
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (
      key !== KEY_ENV &&
      key !== LEGACY_KEY_ENV &&
      /PRIVATE_KEY|SECRET_KEY|KEYPAIR|SIGNER_|^ADMIN_|^WHITELIST_SECRET$|^PINATA_JWT$|^R2_SECRET_ACCESS_KEY$|^HEROKU_API_KEY$|^NODE_OPTIONS$|^NODE_PATH$|^NODE_TLS_REJECT_UNAUTHORIZED$|^NODE_EXTRA_CA_CERTS$/.test(
        key
      )
    )
      fail('MIXED_OR_UNSAFE_WORKER_ENVIRONMENT');
  }
  let rpc, db;
  try {
    if (
      typeof env.RPC_URL !== 'string' ||
      typeof env.DATABASE_URL !== 'string' ||
      env.RPC_URL.length > 8192 ||
      env.DATABASE_URL.length > 8192 ||
      env.RPC_URL.includes('\0') ||
      env.DATABASE_URL.includes('\0')
    )
      fail('PRIVATE_CONNECTION_SETTINGS_INVALID');
    rpc = new URL(env.RPC_URL);
    db = new URL(env.DATABASE_URL);
  } catch {
    fail('PRIVATE_CONNECTION_SETTINGS_REQUIRED');
  }
  if (
    rpc.protocol !== 'https:' ||
    rpc.username ||
    rpc.password ||
    rpc.hash ||
    !['postgres:', 'postgresql:'].includes(db.protocol) ||
    !db.hostname ||
    !db.username ||
    !db.password ||
    db.pathname.length < 2 ||
    db.hash
  )
    fail('PRIVATE_CONNECTION_SETTINGS_INVALID');
  const automatic = env.WALLET_AUTOMATIC_ENABLED === 'true';
  return {
    automatic,
    rewardEnvironment: rewardEnvironment(manifest, env),
    cycles: integer(env, 'WALLET_SERVICE_CYCLES', 240, 1, 10000),
    intervalMs: integer(env, 'WALLET_RESTART_INTERVAL_MS', 15000, 1000, 3600000),
    timeoutMs: integer(env, 'WALLET_CYCLE_TIMEOUT_MS', 900000, 30000, 3600000),
    maximumCoins: integer(env, 'WALLET_MAXIMUM_COINS', 20, 1, 100),
    maximumJobs: integer(env, 'WALLET_MAXIMUM_JOBS', 20, 1, 100),
    slippageBps: integer(env, 'WALLET_SLIPPAGE_BPS', 100, 1, 100),
    buyback: money(env.WALLET_MAXIMUM_BUYBACK_LAMPORTS, automatic),
    payout: money(env.WALLET_MAXIMUM_PAYOUT_LAMPORTS, automatic),
    operating: money(env.WALLET_MAXIMUM_OPERATING_COST_LAMPORTS, automatic),
  };
}
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
function decodeSigningKey(raw, collectorHex) {
  let array, bytes;
  try {
    if (typeof raw !== 'string' || raw.length > 4096) fail('PRIVATE_SIGNER_KEY_REQUIRED');
    array = JSON.parse(raw);
    if (
      !Array.isArray(array) ||
      array.length !== 64 ||
      !array.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)
    )
      fail('PRIVATE_SIGNER_KEY_INVALID');
    bytes = Buffer.from(array);
    const privateKey = crypto.createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        bytes.subarray(0, 32),
      ]),
      format: 'der',
      type: 'pkcs8',
    });
    const publicBytes = crypto
      .createPublicKey(privateKey)
      .export({ format: 'der', type: 'spki' })
      .subarray(-32);
    if (!publicBytes.equals(bytes.subarray(32)) || publicBytes.toString('hex') !== collectorHex)
      fail('PRIVATE_SIGNER_IDENTITY_MISMATCH');
    return Buffer.from(bytes);
  } finally {
    if (Array.isArray(array)) array.fill(0);
    bytes?.fill(0);
  }
}
function cycleProfile(cycle, childEnv, automatic) {
  if (childEnv.LAUNCH_POLICY_VERSION === 'dev-v1')
    return { name: 'dev', automatic, environment: childEnv };
  const legacy = cycle % 2 === 1;
  return {
    name: legacy ? 'historical' : 'bond',
    automatic: !legacy && automatic,
    environment: legacy
      ? {
          ...childEnv,
          POOL_CONFIG_KEY: PINS.legacyConfigKey,
          NEXT_PUBLIC_POOL_CONFIG_KEY: PINS.legacyConfigKey,
          FEE_COLLECTOR_PUBLIC_KEY: PINS.legacyCollector,
        }
      : childEnv,
  };
}
function automaticArguments(automatic, commandFile) {
  return automatic ? ['--automatic', '--signer-config', commandFile] : [];
}
async function run() {
  // The historical secret is retained for rollback only and never passed to a child or loaded.
  delete process.env[LEGACY_KEY_ENV];
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    delete process.env[KEY_ENV];
    emit({
      role: 'private-wallet-worker',
      automaticDefault: false,
      listeners: 0,
      usage:
        'No arguments starts finite supervised scheduler batches. --check-package is offline. --check-config validates settings without reading a signing key.',
    });
    return;
  }
  if (
    args.length > 1 ||
    (args.length === 1 && !['--check-package', '--check-config', '--check-key'].includes(args[0]))
  )
    fail('ARGUMENT_INVALID');
  const manifest = verifyPackage();
  if (args[0] === '--check-package') {
    delete process.env[KEY_ENV];
    emit({
      packageValid: true,
      automaticDefault: false,
      listeners: 0,
      signingKeyRead: false,
      transactionsSent: 0,
    });
    return;
  }
  const settings = configuration(manifest, process.env);
  if (args[0] === '--check-key') {
    let checked;
    try {
      checked = decodeSigningKey(process.env[KEY_ENV], manifest.collectorHex);
      emit({ keyMatchesCollector: true, transactionsSigned: 0, transactionsSent: 0 });
    } finally {
      checked?.fill(0);
      delete process.env[KEY_ENV];
    }
    return;
  }
  if (args[0] === '--check-config') {
    delete process.env[KEY_ENV];
    emit({
      configurationValid: true,
      automatic: settings.automatic,
      signingKeyRead: false,
      transactionsSent: 0,
    });
    return;
  }
  if (
    process.platform !== 'linux' ||
    process.getuid?.() === 0 ||
    Number(process.versions.node.split('.')[0]) !== 24
  )
    fail('LINUX_NONROOT_NODE24_REQUIRED');
  let raw = settings.automatic ? process.env[KEY_ENV] : undefined;
  delete process.env[KEY_ENV];
  if (settings.automatic && (!raw || raw.length > 4096)) fail('PRIVATE_SIGNER_KEY_REQUIRED');
  const privateDir = fs.mkdtempSync('/tmp/rinsed-private-worker-');
  fs.chmodSync(privateDir, 0o700);
  const keyFile = path.join(privateDir, 'key.json'),
    policyFile = path.join(privateDir, 'signer-policy.json'),
    commandFile = path.join(privateDir, 'signer-command.json');
  let active = null,
    stopping = false,
    wake = null,
    escalation = null;
  const stop = () => {
    stopping = true;
    if (wake) wake();
    if (active) {
      active.kill('SIGTERM');
      if (!escalation) escalation = setTimeout(() => active?.kill('SIGKILL'), 35000);
    }
  };
  const childEnv = {
    NODE_ENV: 'production',
    PATH: path.dirname(process.execPath),
    HOME: process.env.HOME || ROOT,
    TMPDIR: privateDir,
    TMP: privateDir,
    TEMP: privateDir,
    RPC_URL: process.env.RPC_URL,
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_SSL_CA: path.join(ROOT, 'rds-ca.crt'),
    NEXT_PUBLIC_NETWORK: 'mainnet-beta',
    POOL_CONFIG_KEY: manifest.configKey,
    NEXT_PUBLIC_POOL_CONFIG_KEY: manifest.configKey,
    FEE_COLLECTOR_PUBLIC_KEY: manifest.collector,
    TREASURY_PUBLIC_KEY: manifest.treasury,
    WALLET_WORKER_ENABLED: 'true',
    MAINNET_TRADING_ENABLED: 'true',
    ...settings.rewardEnvironment,
    ...(manifest.policyVersion ? { LAUNCH_POLICY_VERSION: manifest.policyVersion } : {}),
  };
  try {
    if (settings.automatic) {
      let bytes;
      try {
        bytes = decodeSigningKey(raw, manifest.collectorHex);
        raw = undefined;
        fs.writeFileSync(keyFile, JSON.stringify([...bytes]), { flag: 'wx', mode: 0o600 });
      } finally {
        bytes?.fill(0);
        raw = undefined;
      }
      const environment = Object.fromEntries(
        [
          'RPC_URL',
          'DATABASE_URL',
          'DATABASE_SSL_CA',
          'NEXT_PUBLIC_NETWORK',
          'POOL_CONFIG_KEY',
          'FEE_COLLECTOR_PUBLIC_KEY',
          'TREASURY_PUBLIC_KEY',
          'WALLET_WORKER_ENABLED',
          'MAINNET_TRADING_ENABLED',
          'LAUNCH_POLICY_VERSION',
          ...REWARD_ENVIRONMENT,
        ]
          .filter((name) => childEnv[name] !== undefined)
          .map((name) => [name, childEnv[name]])
      );
      fs.writeFileSync(
        policyFile,
        JSON.stringify({
          version: 1,
          purpose: 'rinsed-wallet-signer',
          keyFile,
          environment,
          limits: {
            maximumBuybackLamports: settings.buyback,
            maximumPayoutLamports: settings.payout,
            maximumOperatingCostLamports: settings.operating,
          },
        }),
        { flag: 'wx', mode: 0o600 }
      );
      fs.writeFileSync(
        commandFile,
        JSON.stringify({
          version: 1,
          executable: process.execPath,
          argv: [
            '--no-global-search-paths',
            path.join(ROOT, 'artifacts/wallet-signer.cjs'),
            '--config',
            policyFile,
          ],
          timeoutMs: 30000,
        }),
        { flag: 'wx', mode: 0o600 }
      );
    }
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    let failures = 0;
    for (let cycle = 0; cycle < settings.cycles && !stopping; cycle++) {
      const profile = cycleProfile(cycle, childEnv, settings.automatic);
      const argv = [
        '--no-global-search-paths',
        path.join(ROOT, 'artifacts/scheduler.cjs'),
        '--execute',
        '--cycles',
        '1',
        '--maximum-coins',
        String(settings.maximumCoins),
        '--maximum-jobs',
        String(settings.maximumJobs),
        '--slippage-bps',
        String(settings.slippageBps),
        ...(settings.buyback && !manifest.policyVersion
          ? ['--max-spend-lamports', settings.buyback]
          : []),
        ...automaticArguments(profile.automatic, commandFile),
      ];
      const result = await new Promise((resolve) => {
        let stdout = '',
          overflow = false,
          terminated = false,
          finished = false;
        active = spawn(process.execPath, argv, {
          cwd: ROOT,
          env: profile.environment,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
        });
        const terminate = () => {
          if (terminated) return;
          terminated = true;
          active?.kill('SIGTERM');
          if (!escalation) escalation = setTimeout(() => active?.kill('SIGKILL'), 35000);
        };
        const timeout = setTimeout(terminate, settings.timeoutMs);
        active.stdout.on('data', (chunk) => {
          stdout += chunk;
          if (Buffer.byteLength(stdout) > 65536) {
            overflow = true;
            stdout = '';
            terminate();
          }
        });
        let stderr = 0;
        active.stderr.on('data', (chunk) => {
          stderr += chunk.length;
          if (stderr > 65536) {
            overflow = true;
            terminate();
          }
        });
        const finish = (code) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          if (escalation) clearTimeout(escalation);
          escalation = null;
          active = null;
          let summary = {};
          for (const line of stdout.split('\n')) {
            try {
              const value = JSON.parse(line);
              for (const name of ['processed', 'failed', 'transactionsSigned', 'transactionsSent'])
                if (Number.isSafeInteger(value[name]) && value[name] >= 0 && value[name] <= 1000000)
                  summary[name] = value[name];
              if (['completed', 'stopped', 'busy'].includes(value.status))
                summary.status = value.status;
              if (Array.isArray(value.alerts))
                summary.alerts = value.alerts
                  .filter(
                    (code) =>
                      typeof code === 'string' && /^(WALLET|SIGNER)_[A-Z_]{1,50}$/.test(code)
                  )
                  .slice(0, 20);
            } catch {}
          }
          resolve({ code, overflow, summary });
        };
        active.once('error', () => finish(1));
        active.once('close', (code) => finish(code));
      });
      emit({
        event: 'private_worker_cycle',
        cycle: cycle + 1,
        profile: profile.name,
        collector: profile.environment.FEE_COLLECTOR_PUBLIC_KEY,
        automatic: profile.automatic,
        ok: result.code === 0 && !result.overflow,
        ...result.summary,
      });
      failures = result.code === 0 && !result.overflow ? 0 : failures + 1;
      if (failures >= 3) fail('PRIVATE_WORKER_REPEATED_FAILURE');
      if (!stopping && cycle + 1 < settings.cycles)
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            wake = null;
            resolve();
          }, settings.intervalMs);
          wake = () => {
            clearTimeout(timer);
            wake = null;
            resolve();
          };
        });
    }
    emit({
      event: 'private_worker_stopped',
      automatic: settings.automatic,
      shutdownRequested: stopping,
    });
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    if (escalation) clearTimeout(escalation);
    raw = undefined;
    fs.chmodSync(privateDir, 0o700);
    for (const file of [keyFile, policyFile, commandFile])
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if (error.code !== 'ENOENT') throw Error('PRIVATE_FILE_CLEANUP_FAILED');
      }
    fs.rmdirSync(privateDir);
  }
}
module.exports = {
  verifyPackage,
  configuration,
  decodeSigningKey,
  cycleProfile,
  automaticArguments,
  PINS,
  DEV_PINS,
};
if (require.main === module)
  run().catch((error) => {
    delete process.env[KEY_ENV];
    process.stderr.write(
      JSON.stringify({
        ok: false,
        code:
          typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code)
            ? error.code
            : 'PRIVATE_WORKER_STOPPED',
        message:
          'Private worker stopped. Key material, configuration and provider output are withheld.',
      }) + '\n'
    );
    process.exitCode = 1;
  });
