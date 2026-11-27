const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto');
const { PublicKey, Keypair } = require('@solana/web3.js');
const core = require('./operator-start.cjs');
const contract = require('./production-schema-contract.json');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const value = structuredClone(require('../operator.config.example.json'));
  return Object.assign(value, {
    reviewed: true,
    poolConfigKey: Keypair.generate().publicKey.toBase58(),
    collectorPublicKey: Keypair.generate().publicKey.toBase58(),
    treasuryPublicKey: Keypair.generate().publicKey.toBase58(),
    configSha256: 'a'.repeat(64),
    schemaCatalogSha256: core.schemaCatalogSha256,
    artifacts: {
      opsSha256: 'b'.repeat(64),
      schedulerSha256: 'c'.repeat(64),
      startupSha256: 'd'.repeat(64),
    },
  });
}
function filesystem(config) {
  const values = new Map([
    [config.files.rpcUrl, 'https://rpc.invalid/?api-key=fixture-only'],
    [config.files.databaseUrl, 'postgres://fixture:fixture-only@db.invalid:5432/fixture'],
    [
      config.files.databaseCa,
      '-----BEGIN CERTIFICATE-----\nfixture-public-ca\n-----END CERTIFICATE-----',
    ],
  ]);
  const io = {
    realpathSync: (file) => file,
    statSync: (file) => ({
      dev: 1,
      ino: [...values.keys()].indexOf(file) + 2,
      gid: 1000,
      nlink: 1,
      mtimeNs: 0n,
      ctimeNs: 0n,
      uid: 1000,
      mode: 0o100600,
      size: values.get(file)?.length ?? 0,
      isFile: () => values.has(file),
      isDirectory: () => file === config.exportsDirectory,
    }),
    accessSync: () => {},
  };
  const descriptors = new Map();
  let next = 1;
  io.lstatSync = (file) => io.statSync(file);
  io.openSync = (file) => {
    const fd = next++;
    descriptors.set(fd, file);
    return fd;
  };
  io.fstatSync = (fd) => io.statSync(descriptors.get(fd));
  io.readSync = (fd, buffer, offset, length, position) =>
    Buffer.from(values.get(descriptors.get(fd))).copy(buffer, offset, position, position + length);
  io.closeSync = (fd) => descriptors.delete(fd);
  return { values, io };
}
test('wallet configuration requires explicit review, network/company pins and finite unsigned limits', () => {
  assert.throws(
    () => core.validateOperatorConfig(require('../operator.config.example.json')),
    /REVIEW_REQUIRED/
  );
  assert.equal(core.validateOperatorConfig(fixture()).network, 'devnet');
  for (const patch of [
    { version: 1 },
    { programId: Keypair.generate().publicKey.toBase58() },
    { network: 'mainnet-beta', genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' },
    { mainnetTradingEnabled: true },
    { collectorPublicKey: PublicKey.default.toBase58() },
    { configSha256: '0'.repeat(64) },
    { schemaCatalogSha256: '1'.repeat(64) },
    { signer: {} },
  ])
    assert.throws(() => core.validateOperatorConfig({ ...fixture(), ...patch }));
  for (const patch of [
    { cycles: 0 },
    { cycles: Infinity },
    { maximumJobs: 101 },
    { automatic: true },
    { maximumRuntimeSeconds: 0 },
    { buyback: { maximumSpendLamports: '18446744073709551616', maximumSlippageBps: 100 } },
  ])
    assert.throws(() =>
      core.validateOperatorConfig({ ...fixture(), scheduler: { ...fixture().scheduler, ...patch } })
    );
});
test('mainnet remains disabled by default and only explicit reviewed owner pins permit unsigned preparation', () => {
  const cfg = fixture(),
    pins = require('../docs/mainnet-authorities.public.json');
  Object.assign(cfg, {
    network: 'mainnet-beta',
    genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    mainnetTradingEnabled: true,
  });
  assert.throws(() => core.validateOperatorConfig(cfg), /COMPANY_WALLET_PINS/);
  Object.assign(cfg, {
    collectorPublicKey: pins.company.collector,
    treasuryPublicKey: pins.vault.treasury,
  });
  assert.equal(core.validateOperatorConfig(cfg).mainnetTradingEnabled, true);
  assert.ok(!core.schedulerArguments(cfg).includes('--automatic'));
});
test('runtime accepts only private DB/RPC files and never passes vault, checkpoint or signer settings', () => {
  const cfg = fixture(),
    { io } = filesystem(cfg),
    env = core.loadOperatorEnvironment(cfg, { io, uid: 1000, inherited: {} });
  assert.equal(env.WALLET_WORKER_ENABLED, 'true');
  assert.equal(env.MAINNET_TRADING_ENABLED, 'false');
  assert.equal(env.FEE_COLLECTOR_PUBLIC_KEY, cfg.collectorPublicKey);
  assert.equal(env.TREASURY_PUBLIC_KEY, cfg.treasuryPublicKey);
  assert.ok(!Object.keys(env).some((key) => /VAULT|CHECKPOINT|SIGNER|PRIVATE_KEY/.test(key)));
  for (const inherited of [
    { OPERATOR_PRIVATE_KEY: 'fake' },
    { WALLET_SIGNER_COMMAND_JSON: 'fake' },
    { VAULT_PROGRAM_ID: 'stale' },
    { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  ])
    assert.throws(
      () => core.loadOperatorEnvironment(cfg, { io, uid: 1000, inherited }),
      /UNSAFE_ENVIRONMENT/
    );
  assert.throws(
    () =>
      core.privateFile(
        cfg.files.rpcUrl,
        { ...io, lstatSync: () => ({ ...io.statSync(cfg.files.rpcUrl), mode: 0o100644 }) },
        1000
      ),
    /PERMISSIONS/
  );
  assert.throws(
    () => core.privateFile(cfg.files.rpcUrl, { ...io, realpathSync: () => '/tmp/public' }, 1000),
    /PERMISSIONS/
  );
});
test('forwards the reviewed Masked config pin and wXMR market to the mainnet operator', () => {
  const cfg = fixture();
  const pins = require('../docs/mskd-mainnet-dev-wallets.public.json');
  const maskedConfigKey = Keypair.generate().publicKey.toBase58();
  const market = Keypair.generate().publicKey.toBase58();
  assert.throws(
    () => core.validateOperatorConfig({ ...cfg, maskedConfigKey }),
    /MASKED_CONFIG_PIN/
  );
  Object.assign(cfg, {
    network: 'mainnet-beta',
    genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    mainnetTradingEnabled: true,
    poolPolicyVersion: 'dev-v1',
    collectorPublicKey: pins.collector,
    treasuryPublicKey: pins.treasury,
    mskdPayout: { pool: market, devnetMint: null },
    maskedConfigKey,
  });
  const { io } = filesystem(cfg);
  const env = core.loadOperatorEnvironment(core.validateOperatorConfig(cfg), {
    io,
    uid: 1000,
    inherited: { MAINNET_MASKED_CONFIG_KEY: 'ignored' },
  });
  assert.equal(env.MAINNET_MASKED_CONFIG_KEY, maskedConfigKey);
  assert.equal(env.MSKD_PAYOUT_POOL, market);
  assert.throws(
    () => core.validateOperatorConfig({ ...cfg, maskedConfigKey: cfg.poolConfigKey }),
    /MASKED_CONFIG_PIN/
  );
});
test('bounded fd reads reject FIFO, replaced paths, growing input and changed permissions', () => {
  const cfg = fixture(),
    { io } = filesystem(cfg),
    file = cfg.files.rpcUrl;
  let opens = 0;
  assert.throws(
    () =>
      core.privateFile(
        file,
        {
          ...io,
          lstatSync: () => ({ ...io.statSync(file), isFile: () => false }),
          openSync: () => {
            opens++;
          },
        },
        1000
      ),
    /PERMISSIONS/
  );
  assert.equal(opens, 0);
  assert.throws(
    () =>
      core.privateFile(
        file,
        { ...io, fstatSync: (fd) => ({ ...io.fstatSync(fd), ino: 999 }) },
        1000
      ),
    /CHANGED/
  );
  let reads = 0;
  assert.throws(
    () =>
      core.privateFile(
        file,
        {
          ...io,
          readSync: (_fd, buffer, offset, length) => {
            reads++;
            buffer.fill(65, offset, offset + length);
            return length;
          },
        },
        1000
      ),
    /CAPACITY/
  );
  assert.equal(reads, 1);
  let stats = 0;
  assert.throws(
    () =>
      core.privateFile(
        file,
        {
          ...io,
          lstatSync: () => ({
            ...io.statSync(file),
            ino: ++stats === 1 ? io.statSync(file).ino : 888,
          }),
        },
        1000
      ),
    /CHANGED/
  );
  let checks = 0;
  assert.throws(
    () =>
      core.privateFile(
        file,
        {
          ...io,
          fstatSync: (fd) => ({ ...io.fstatSync(fd), mode: ++checks === 1 ? 0o100600 : 0o100644 }),
        },
        1000
      ),
    /PERMISSIONS/
  );
});
test('public configuration uses the same bounded regular-file reader', () => {
  const cfg = fixture(),
    { io, values } = filesystem(cfg),
    file = cfg.files.rpcUrl;
  assert.equal(core.readOperatorConfigFile(file, io).toString(), values.get(file));
  values.set(file, 'x'.repeat(16385));
  assert.throws(() => core.readOperatorConfigFile(file, io), /PERMISSIONS/);
});
function chain(config) {
  const dbc = Buffer.alloc(1048);
  Buffer.from([26, 108, 14, 123, 116, 230, 129, 43]).copy(dbc);
  new PublicKey('So11111111111111111111111111111111111111112').toBuffer().copy(dbc, 8);
  new PublicKey(config.collectorPublicKey).toBuffer().copy(dbc, 40);
  new PublicKey(config.treasuryPublicKey).toBuffer().copy(dbc, 72);
  dbc.writeBigUInt64LE(900000000n, 104);
  dbc.writeBigUInt64LE(3n, 112);
  dbc.writeBigUInt64LE(3782n, 120);
  dbc.writeUInt16LE(9, 128);
  dbc[130] = 1;
  dbc[233] = 1;
  dbc[234] = 1;
  dbc[235] = 6;
  dbc[239] = 100;
  dbc[243] = 6;
  dbc[244] = 1;
  dbc[246] = 1;
  dbc.writeBigUInt64LE(80000000000n, 264);
  dbc.writeBigUInt64LE(1000000000000000n, 344);
  dbc.writeBigUInt64LE(1000000000000000n, 352);
  dbc.writeUInt16LE(125, 362);
  dbc[365] = 1;
  config.configSha256 = sha(dbc);
  const owner = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
  return {
    dbc,
    owner,
    rpc: {
      getGenesisHash: async () => config.genesis,
      getAccountInfo: async () => ({ owner, executable: false, data: dbc }),
    },
  };
}
function database(config) {
  const queries = [],
    client = {
      query: async (sql) => {
        queries.push(sql);
        if (sql.includes('pg_stat_ssl')) return { rows: [{ ssl: true }] };
        if (sql.includes('FROM launch_configs'))
          return {
            rows: [
              {
                enabled_for_launch: true,
                policy_version: 'wallet-v1',
                config_digest: config.configSha256,
                expected_fee_claimer: config.collectorPublicKey,
                expected_leftover_receiver: config.treasuryPublicKey,
              },
            ],
          };
        return { rows: [] };
      },
      release() {},
    };
  return {
    queries,
    pool: { connect: async () => client },
    readCatalog: async () => structuredClone(contract.catalog),
  };
}
test('read-only deployment probe verifies actual DBC wallet policy and TLS schema with no native account', async () => {
  const cfg = fixture(),
    c = chain(cfg),
    db = database(cfg);
  const result = await core.probeOperatorDeployment(cfg, {}, { rpc: c.rpc, ...db });
  assert.equal(result.requiresNativeProgram, false);
  assert.equal(result.reviewedWalletConfigVerified, true);
  assert.ok(db.queries.every((sql) => /^(SELECT|BEGIN READ ONLY|ROLLBACK|SET LOCAL)/.test(sql)));
  c.dbc.writeBigUInt64LE(700000000n, 104);
  cfg.configSha256 = sha(c.dbc);
  await assert.rejects(
    core.probeOperatorDeployment(cfg, {}, { rpc: c.rpc, ...db }),
    /REVIEWED_CONFIG/
  );
});
test('wrong network, changed bank, altered collector or weakened schema stop before scheduling', async () => {
  const cfg = fixture(),
    c = chain(cfg),
    db = database(cfg);
  let calls = 0;
  c.rpc.getGenesisHash = async () => (++calls === 1 ? cfg.genesis : 'wrong-bank');
  await assert.rejects(
    core.probeOperatorDeployment(cfg, {}, { rpc: c.rpc, ...db }),
    /NETWORK_CHANGED/
  );
  c.rpc.getGenesisHash = async () => cfg.genesis;
  await assert.rejects(
    core.probeOperatorDeployment(
      cfg,
      {},
      { rpc: c.rpc, ...db, readCatalog: async () => ({ ...contract.catalog, constraints: [] }) }
    ),
    /SCHEMA_MISMATCH/
  );
  new PublicKey(Keypair.generate().publicKey).toBuffer().copy(c.dbc, 40);
  cfg.configSha256 = sha(c.dbc);
  await assert.rejects(
    core.probeOperatorDeployment(cfg, {}, { rpc: c.rpc, ...db }),
    /REVIEWED_CONFIG/
  );
});
test('artifact pins require the actual portable wallet-v1 runtime and private package evidence', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rinsed-operator-start-'));
  t.after(() => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('rinsed-operator-start-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const cfg = fixture();
  for (const [file, key] of [
    ['ops.cjs', 'opsSha256'],
    ['scheduler.cjs', 'schedulerSha256'],
    ['operator-start.cjs', 'startupSha256'],
  ]) {
    fs.writeFileSync(path.join(dir, file), 'fixture');
    cfg.artifacts[key] = sha('fixture');
  }
  const files = {
    'ops.cjs': sha('fixture'),
    'scheduler.cjs': sha('fixture'),
    'operator-start.cjs': sha('fixture'),
  };
  fs.writeFileSync(
    path.join(dir, 'runtime-manifest.json'),
    JSON.stringify({
      version: 2,
      policy: 'wallet-v1',
      dependencyTreeAbsent: true,
      globalModuleSearchDisabled: true,
      isolatedDryRunsPassed: true,
      signaturesCreated: 0,
      transactionsSent: 0,
      files,
    })
  );
  fs.writeFileSync(
    path.join(dir, 'private-package-manifest.json'),
    JSON.stringify({
      version: 2,
      policy: 'wallet-v1',
      nodeMajor: 24,
      pnpm: '10.27.0',
      unsignedSchedulerOnly: true,
      containsSigner: false,
      startupOutsideCheckoutHelpPassed: true,
      globalModuleSearchDisabled: true,
      files,
    })
  );
  core.verifyOperatorArtifacts(cfg, dir);
  fs.writeFileSync(path.join(dir, 'scheduler.cjs'), 'altered');
  assert.throws(() => core.verifyOperatorArtifacts(cfg, dir), /ARTIFACT_PIN/);
});
test('supervisor launches only finite unsigned scheduler arguments and forwards SIGTERM', async () => {
  const signals = new EventEmitter(),
    child = new EventEmitter(),
    killed = [],
    cfg = fixture();
  let spawned;
  child.kill = (signal) => {
    killed.push(signal);
    queueMicrotask(() => child.emit('exit', 0, null));
  };
  const env = { WALLET_WORKER_ENABLED: 'true', MAINNET_TRADING_ENABLED: 'false' };
  const pending = core.superviseUnsignedScheduler(cfg, env, {
    signals,
    directory: '/private/artifact',
    spawnImpl: (...args) => {
      spawned = args;
      return child;
    },
  });
  signals.emit('SIGTERM');
  assert.equal(await pending, 143);
  assert.deepEqual(killed, ['SIGTERM']);
  assert.equal(spawned[2].env, env);
  assert.equal(spawned[2].shell, false);
  assert.ok(spawned[1].includes(path.join('/private/artifact', 'scheduler.cjs')));
  assert.ok(!spawned[1].some((arg) => /automatic|signer|relay/.test(arg)));
  assert.ok(spawned[1].includes('--maximum-jobs'));
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});
test('runtime deadline escalates a stuck child and reports timeout instead of success', async () => {
  const signals = new EventEmitter(),
    child = new EventEmitter(),
    killed = [],
    callbacks = [],
    cleared = [];
  child.kill = (signal) => {
    killed.push(signal);
  };
  const timers = {
    setTimeout: (fn) => {
      callbacks.push(fn);
      return { unref() {} };
    },
    clearTimeout: (timer) => {
      cleared.push(timer);
    },
  };
  const pending = core.superviseUnsignedScheduler(
    fixture(),
    {},
    { signals, timers, spawnImpl: () => child }
  );
  callbacks[0]();
  callbacks[1]();
  child.emit('exit', null, 'SIGKILL');
  assert.equal(await pending, 124);
  assert.deepEqual(killed, ['SIGTERM', 'SIGKILL']);
  assert.equal(cleared.length, 2);
});
test('private image remains digest-pinned, nonroot, signer-free and listener-free', () => {
  const docker = fs.readFileSync(path.resolve(__dirname, '../Dockerfile.operator'), 'utf8'),
    ignore = fs.readFileSync(
      path.resolve(__dirname, '../Dockerfile.operator.dockerignore'),
      'utf8'
    ),
    proc = fs.readFileSync(path.resolve(__dirname, '../Procfile.operator'), 'utf8');
  assert.equal(
    (
      docker.match(
        /node:24\.22\.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c/g
      ) ?? []
    ).length,
    2
  );
  assert.match(docker, /USER node/);
  assert.match(docker, /chmod 0700/);
  assert.match(docker, /STOPSIGNAL SIGTERM/);
  assert.doesNotMatch(docker, /EXPOSE|signer\.cjs|COPY \. /);
  assert.match(docker, /--frozen-lockfile/);
  assert.match(docker, /pnpm@10\.27\.0/);
  assert.ok(ignore.startsWith('**\n') || ignore.startsWith('**\r\n'));
  assert.match(ignore, /\*\*\/\.env\*/);
  assert.match(ignore, /\*\*\/\*\.md/);
  assert.doesNotMatch(proc, /^web:/m);
});
