const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  { createRequire } = require('node:module'),
  { spawnSync } = require('node:child_process');
const app = createRequire(path.resolve(__dirname, '../scaffolds/fun-launch/package.json')),
  { PublicKey } = app('@solana/web3.js'),
  BN = app('bn.js'),
  sdk = app('@meteora-ag/dynamic-bonding-curve-sdk'),
  ts = app('typescript');
const {
    collectProductionPreflight,
    validateExpectations,
    inspectProgram,
    programDataAddress,
    UPGRADEABLE,
    decodeConfig,
  } = require('./production-preflight-core.cjs'),
  { sha } = require('./production-schema.cjs'),
  { NETWORK_GENESIS } = require('./network-policy.cjs');
const roles = ['dbc', 'damm', 'metadata'],
  pub = (byte) => new PublicKey(Buffer.alloc(32, byte)),
  clone = (value) => JSON.parse(JSON.stringify(value));
function fixture() {
  const owner = require('../docs/mainnet-authorities.public.json'),
    collector = new PublicKey(owner.company.collector),
    treasury = new PublicKey(owner.vault.treasury),
    governor = pub(20),
    config = pub(23),
    addresses = [
      sdk.DYNAMIC_BONDING_CURVE_PROGRAM_ID,
      sdk.DAMM_V2_PROGRAM_ID,
      sdk.METAPLEX_PROGRAM_ID,
    ],
    accounts = [],
    dataAccounts = [],
    programs = {};
  for (const [index, role] of roles.entries()) {
    const code = Buffer.concat([Buffer.from('7f454c46', 'hex'), Buffer.alloc(32, index + 1)]),
      data = Buffer.alloc(45 + code.length),
      program = Buffer.alloc(36);
    data.writeUInt32LE(3);
    data.writeBigUInt64LE(1n, 4);
    data[12] = role === 'metadata' ? 0 : 1;
    if (data[12]) governor.toBuffer().copy(data, 13);
    code.copy(data, 45);
    program.writeUInt32LE(2);
    programDataAddress(addresses[index]).toBuffer().copy(program, 4);
    accounts.push({ owner: UPGRADEABLE, executable: true, data: program });
    dataAccounts.push({ owner: UPGRADEABLE, executable: false, data });
    programs[role] = {
      address: addresses[index].toBase58(),
      upgradeAuthority: role === 'metadata' ? null : governor.toBase58(),
      deployedDataSha256: sha(code),
    };
  }
  const configData = Buffer.from('immutable reviewed wallet config'),
    migrationData = Buffer.from('canonical migration config'),
    expected = {
      version: 2,
      networkGenesis: NETWORK_GENESIS['mainnet-beta'],
      siteOrigin: 'https://example.test',
      programs,
      company: { collector: collector.toBase58(), treasury: treasury.toBase58() },
      config: {
        address: config.toBase58(),
        digest: sha(configData),
        feeClaimer: collector.toBase58(),
        leftoverReceiver: treasury.toBase58(),
        registryEnabled: true,
        migrationConfig: {
          address: sdk.DAMM_V2_MIGRATION_FEE_ADDRESS[6].toBase58(),
          digest: sha(migrationData),
        },
      },
      schemaContractSha256: 'a'.repeat(64),
      worker: {
        operatorArtifactSha256: 'b'.repeat(64),
        schedulerArtifactSha256: 'c'.repeat(64),
        maxHeartbeatAgeSeconds: 180,
      },
    },
    env = {
      NODE_ENV: 'production',
      NEXT_PUBLIC_NETWORK: 'mainnet-beta',
      POOL_CONFIG_KEY: expected.config.address,
      NEXT_PUBLIC_POOL_CONFIG_KEY: expected.config.address,
      FEE_COLLECTOR_PUBLIC_KEY: expected.company.collector,
      TREASURY_PUBLIC_KEY: expected.company.treasury,
      NEXT_PUBLIC_SITE_URL: expected.siteOrigin,
      WALLET_WORKER_ENABLED: 'true',
      MAINNET_TRADING_ENABLED: 'false',
    };
  const parsed = ts.parseConfigFileTextToJson(
      'config.jsonc',
      fs.readFileSync(path.resolve(__dirname, '../studio/config/dbc_config.jsonc'), 'utf8')
    ).config,
    { buildCurveMode, feeClaimer, leftoverReceiver, ...params } = parsed.dbcConfig,
    built = sdk.buildCurve(params),
    decoded = {
      ...built,
      quoteMint: parsed.quoteMint,
      feeClaimer: expected.company.collector,
      leftoverReceiver: expected.company.treasury,
      preMigrationTokenSupply: built.tokenSupply.preMigrationTokenSupply,
      postMigrationTokenSupply: built.tokenSupply.postMigrationTokenSupply,
      migratedCollectFeeMode: built.migratedPoolFee.collectFeeMode,
      migratedDynamicFee: built.migratedPoolFee.dynamicFee,
      migratedPoolFeeBps: built.migratedPoolFee.poolFeeBps,
      migrationFeePercentage: built.migrationFee.feePercentage,
      creatorMigrationFeePercentage: built.migrationFee.creatorFeePercentage,
    };
  const values = [
    ...accounts,
    ...dataAccounts,
    { owner: addresses[0], executable: false, data: configData },
    { owner: addresses[1], executable: false, data: migrationData },
  ];
  let rpcReads = 0,
    broadcasts = 0,
    released = false;
  const rpc = {
    getGenesisHash: async () => {
      rpcReads++;
      return expected.networkGenesis;
    },
    getMultipleAccountsInfoAndContext: async (keys, options) => {
      assert.equal(keys.length, 8);
      assert.equal(options.commitment, 'finalized');
      rpcReads++;
      return { context: { slot: 100 }, value: values };
    },
    sendTransaction: () => {
      broadcasts++;
      throw Error('No mutation permitted');
    },
  };
  const catalog = {
      tables: ['launch_configs'],
      columns: [],
      constraints: [],
      indexes: [],
      triggers: [],
      functions: [],
    },
    contract = { version: 1, sourceNormalization: 'LF', migrations: [], catalog },
    inventory = {
      migrations: [],
      schemaContract: { sha256: expected.schemaContractSha256 },
      operatorArtifact: { sha256: expected.worker.operatorArtifactSha256 },
      schedulerArtifact: { sha256: expected.worker.schedulerArtifactSha256 },
    },
    registry = {
      policy_version: 'wallet-v1',
      expected_fee_claimer: expected.company.collector,
      expected_leftover_receiver: expected.company.treasury,
      config_digest: expected.config.digest,
      enabled_for_launch: true,
      verified_slot: '5',
    },
    heartbeat = {
      last_started_at: new Date(),
      last_completed_at: new Date(),
      last_progress_at: new Date(),
      last_status: 'completed',
      last_processed: 0,
      last_failed: 0,
      database_now: new Date(),
    },
    queries = [];
  const pool = {
    connect: async () => ({
      release: () => {
        released = true;
      },
      query: async (sql, args) => {
        queries.push(sql);
        assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i);
        if (sql === 'SHOW transaction_read_only')
          return { rows: [{ transaction_read_only: 'on' }] };
        if (sql.includes('pg_stat_ssl')) return { rows: [{ ssl: true }] };
        if (sql.includes('information_schema.tables'))
          return { rows: catalog.tables.map((table_name) => ({ table_name })) };
        if (sql.includes('information_schema.columns')) return { rows: catalog.columns };
        if (sql.includes('FROM pg_constraint')) return { rows: catalog.constraints };
        if (sql.includes('FROM pg_indexes')) return { rows: catalog.indexes };
        if (sql.includes('FROM pg_trigger')) return { rows: catalog.triggers };
        if (sql.includes('FROM pg_proc')) return { rows: [] };
        if (sql.includes('FROM public.launch_configs')) {
          assert.deepEqual(args, [expected.networkGenesis, expected.config.address]);
          return { rows: [registry] };
        }
        if (sql.includes('FROM public.wallet_scheduler_state')) {
          assert.deepEqual(args, [expected.networkGenesis, expected.company.collector]);
          return { rows: [heartbeat] };
        }
        return { rows: [] };
      },
    }),
  };
  return {
    expected,
    env,
    rpc,
    pool,
    contract,
    inventory,
    configDecoder: () => decoded,
    values,
    registry,
    heartbeat,
    queries,
    counters: () => ({ rpcReads, broadcasts, released }),
  };
}
const passed = (report, id) => report.checks.find((check) => check.id === id)?.status === 'pass';
test('requires independently reviewed wallet/protocol pins before any RPC or SQL read', async () => {
  const f = fixture();
  delete f.expected.programs.dbc.upgradeAuthority;
  const report = await collectProductionPreflight(f);
  assert.ok(report.inputs.missing.includes('programs.dbc.upgradeAuthority'));
  assert.equal(f.counters().rpcReads, 0);
  assert.equal(f.queries.length, 0);
  const empty = await collectProductionPreflight({ inventory: f.inventory });
  assert.deepEqual(empty.inputs.missing, ['independentlyReviewedPublicExpectations']);
});
test('verifies wallet-v1 policy, protocol code, frozen schema and scoped unsigned heartbeat without native fields', async () => {
  const f = fixture(),
    report = await collectProductionPreflight(f);
  assert.equal(report.technicalChecksPassed, true, JSON.stringify(report.checks));
  assert.equal(report.requiresNativeProgram, false);
  assert.equal(report.financialReleaseReady, false);
  assert.equal(report.mainnetGateOpened, false);
  assert.equal(f.counters().broadcasts, 0);
  assert.equal(f.counters().released, true);
  assert.equal(f.queries.at(-1), 'ROLLBACK');
  assert.ok(!report.checks.some((value) => /vault/.test(value.id)));
  assert.ok(f.queries.includes("SET LOCAL TIME ZONE 'UTC'"));
});

test('recognizes the exact Bond it. slot scheduler and binds database admission to bond-v1', async () => {
  const f = fixture(),
    old = f.configDecoder();
  f.configDecoder = () => ({
    ...old,
    activationType: 0,
    enableFirstSwapWithMinFee: true,
    migratedPoolFeeBps: 100,
    poolFees: {
      ...old.poolFees,
      baseFee: {
        ...old.poolFees.baseFee,
        cliffFeeNumerator: new BN(990000000),
        firstFactor: 1,
        secondFactor: new BN(1),
        thirdFactor: new BN(977500000),
        baseFeeMode: 0,
      },
    },
  });
  f.registry.policy_version = 'bond-v1';
  const report = await collectProductionPreflight(f);
  assert.equal(report.policy, 'bond-v1');
  assert.equal(report.technicalChecksPassed, true, JSON.stringify(report.checks));
  assert.equal(report.scheduledEndpointNumerator, '12500000');
  assert.equal(f.counters().broadcasts, 0);
});
test('binds reviewed Masked policy to its own mainnet pin and the active Dev company wallets', async () => {
  const f = fixture(),
    old = f.configDecoder();
  const { collector, treasury } = require('../docs/mskd-mainnet-dev-wallets.public.json');
  f.expected.company = { collector, treasury };
  Object.assign(f.expected.config, {
    policyVersion: 'masked-v1',
    feeClaimer: collector,
    leftoverReceiver: treasury,
  });
  Object.assign(f.env, {
    LAUNCH_POLICY_VERSION: 'dev-v1',
    MAINNET_MASKED_CONFIG_KEY: f.expected.config.address,
    POOL_CONFIG_KEY: pub(24).toBase58(),
    NEXT_PUBLIC_POOL_CONFIG_KEY: pub(24).toBase58(),
    FEE_COLLECTOR_PUBLIC_KEY: collector,
    TREASURY_PUBLIC_KEY: treasury,
  });
  Object.assign(f.registry, {
    policy_version: 'masked-v1',
    expected_fee_claimer: collector,
    expected_leftover_receiver: treasury,
  });
  f.configDecoder = () => ({
    ...old,
    feeClaimer: collector,
    leftoverReceiver: treasury,
    activationType: 0,
    enableFirstSwapWithMinFee: true,
    migratedPoolFeeBps: 125,
    poolFees: {
      ...old.poolFees,
      baseFee: {
        ...old.poolFees.baseFee,
        cliffFeeNumerator: new BN(990000000),
        firstFactor: 1,
        secondFactor: new BN(1),
        thirdFactor: new BN(977500000),
        baseFeeMode: 0,
      },
    },
  });
  const report = await collectProductionPreflight(f);
  assert.equal(report.policy, 'masked-v1');
  assert.equal(report.technicalChecksPassed, true, JSON.stringify(report.checks));
  assert.equal(f.counters().broadcasts, 0);
  f.env.MAINNET_MASKED_CONFIG_KEY = f.env.POOL_CONFIG_KEY;
  assert.equal(passed(await collectProductionPreflight(f), 'config.mainnetModePin'), false);
});
test('rejects native recipients or extra custom-program approvals instead of silently using old custody', async () => {
  for (const mutate of [
    (f) => {
      f.expected.programs.vault = clone(f.expected.programs.dbc);
    },
    (f) => {
      f.expected.vault = { paused: false };
    },
    (f) => {
      const pda = PublicKey.findProgramAddressSync(
        [Buffer.from('fee-authority')],
        pub(19)
      )[0].toBase58();
      f.expected.company.collector = pda;
      f.expected.config.feeClaimer = pda;
    },
    (f) => {
      f.expected.version = 1;
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.equal((await collectProductionPreflight(f)).technicalChecksPassed, false);
    assert.equal(f.counters().rpcReads, 0);
  }
});
test('rejects protocol code, upgrade authority and canonical loader-binding drift', async () => {
  for (const offset of [13, 48]) {
    const f = fixture();
    f.values[3].data[offset] ^= 1;
    assert.equal((await collectProductionPreflight(f)).technicalChecksPassed, false);
  }
  const f = fixture();
  pub(30).toBuffer().copy(f.values[0].data, 4);
  assert.throws(
    () =>
      inspectProgram(
        new PublicKey(f.expected.programs.dbc.address),
        f.values[0],
        f.values[3],
        f.expected.programs.dbc
      ),
    /BINDING/
  );
});
test('wrong bank, immutable recipient mismatch and registry digest drift cannot pass', async () => {
  const wrong = fixture();
  wrong.rpc.getGenesisHash = async () => NETWORK_GENESIS.devnet;
  assert.equal(
    passed(await collectProductionPreflight(wrong), 'rpc.independentlyPinnedGenesis'),
    false
  );
  for (const mutate of [
    (f) => {
      f.expected.config.leftoverReceiver = pub(31).toBase58();
    },
    (f) => {
      f.registry.config_digest = 'f'.repeat(64);
    },
    (f) => {
      f.registry.policy_version = 'rinse-v1';
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.equal((await collectProductionPreflight(f)).technicalChecksPassed, false);
  }
});
test('schema drift and disabled new-launch admission fail without changing existing reward rights', async () => {
  const f = fixture();
  f.expected.config.registryEnabled = false;
  f.registry.enabled_for_launch = false;
  const report = await collectProductionPreflight(f);
  assert.equal(passed(report, 'database.registry'), true);
  assert.equal(passed(report, 'config.launchesEnabled'), false);
  assert.equal(
    report.checks.find((check) => check.id === 'config.launchesEnabled').details
      .existingFundedClaimsSeparate,
    true
  );
  const drift = fixture();
  drift.contract.catalog.columns.push({
    table_name: 'launch_configs',
    column_name: 'required',
    udt_name: 'int8',
  });
  const connect = drift.pool.connect;
  drift.pool.connect = async () => {
    const client = await connect(),
      query = client.query;
    client.query = async (sql, args) =>
      sql.includes('information_schema.columns') ? { rows: [] } : query(sql, args);
    return client;
  };
  assert.equal(passed(await collectProductionPreflight(drift), 'database.schema'), false);
});
test('stale/failed heartbeat never proves signer availability', async () => {
  for (const change of [
    { last_status: 'failed' },
    { last_failed: 1 },
    { last_started_at: new Date(0), last_completed_at: new Date(0), last_progress_at: new Date(0) },
  ]) {
    const f = fixture();
    Object.assign(f.heartbeat, change);
    const report = await collectProductionPreflight(f);
    assert.equal(passed(report, 'worker.unsignedPlannerHeartbeat'), false);
    assert.equal(
      report.externalRequirements.find((row) => row.id === 'external-signer-and-relay-liveness')
        .status,
      'unknown'
    );
  }
});
test('fails closed on missing TLS and redacts provider/database failures', async () => {
  const f = fixture(),
    connect = f.pool.connect;
  f.pool.connect = async () => {
    const client = await connect(),
      query = client.query;
    client.query = async (sql, args) =>
      sql.includes('pg_stat_ssl') ? { rows: [{ ssl: false }] } : query(sql, args);
    return client;
  };
  assert.equal(passed(await collectProductionPreflight(f), 'database.tls'), false);
  for (const target of ['rpc', 'pool']) {
    const a = fixture();
    if (target === 'rpc')
      a.rpc.getMultipleAccountsInfoAndContext = async () => {
        throw Error('https://private.provider/?key=DO_NOT_DISCLOSE');
      };
    else
      a.pool.connect = async () => {
        throw Error('postgres://private:DO_NOT_DISCLOSE@private-host/db');
      };
    const report = await collectProductionPreflight(a);
    assert.equal(report.technicalChecksPassed, false);
    assert.doesNotMatch(JSON.stringify(report), /DO_NOT_DISCLOSE|private.provider|private-host/);
    assert.equal(a.counters().broadcasts, 0);
  }
});
test('missing environment and operator artifacts cannot pass readiness', async () => {
  for (const mutate of [
    (f) => {
      delete f.env.FEE_COLLECTOR_PUBLIC_KEY;
    },
    (f) => {
      f.inventory.operatorArtifact.sha256 = 'f'.repeat(64);
    },
    (f) => {
      f.env.WALLET_WORKER_ENABLED = 'false';
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.equal((await collectProductionPreflight(f)).technicalChecksPassed, false);
  }
});
test('CLI inventory and missing-input modes are offline and never echo provider credentials', () => {
  for (const args of [['--inventory'], []]) {
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, 'production-preflight.mjs'), ...args],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          RPC_URL: 'https://unreachable.invalid/DO_NOT_DISCLOSE',
          DATABASE_URL: 'postgres://private:DO_NOT_DISCLOSE@unreachable.invalid/db',
        },
        timeout: 15000,
      }
    );
    assert.equal(result.status, args.length ? 0 : 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.readOnly, true);
    assert.equal(report.financialReleaseReady, false);
    assert.doesNotMatch(result.stdout + result.stderr, /DO_NOT_DISCLOSE/);
  }
});
test('decodes actual SDK account bytes without constructing a wallet or transaction client', async () => {
  const { BorshCoder } = app('@coral-xyz/anchor'),
    { convertIdlToCamelCase } = app('@coral-xyz/anchor/dist/cjs/idl.js'),
    idl = convertIdlToCamelCase(sdk.DynamicBondingCurveIdl),
    coder = new BorshCoder(idl);
  const zero = (type) => {
    if (typeof type === 'string') {
      if (type === 'pubkey') return PublicKey.default;
      if (['u64', 'i64', 'u128', 'i128', 'u256', 'i256'].includes(type)) return new BN(0);
      if (type === 'bool') return false;
      return 0;
    }
    if (type.array) return Array.from({ length: type.array[1] }, () => zero(type.array[0]));
    if (type.defined) {
      const definition = idl.types.find((value) => value.name === type.defined.name);
      return Object.fromEntries(
        definition.type.fields.map((field) => [field.name, zero(field.type)])
      );
    }
    throw Error('Unsupported fixture IDL');
  };
  const state = zero({ defined: { name: 'poolConfig' } });
  state.quoteMint = sdk.DYNAMIC_BONDING_CURVE_PROGRAM_ID;
  state.tokenDecimal = 6;
  state.preMigrationTokenSupply = new BN('1000000000000000');
  state.poolFees.baseFee.cliffFeeNumerator = new BN(900000000);
  // Anchor's encode convenience buffer is1000bytes; the real config layout is larger.
  const buffer = Buffer.alloc(16 * 1024),
    size = coder.accounts.accountLayouts.get('poolConfig').layout.encode(state, buffer);
  const bytes = Buffer.concat([
      coder.accounts.accountDiscriminator('poolConfig'),
      buffer.subarray(0, size),
    ]),
    decoded = decodeConfig(bytes);
  assert.equal(decoded.tokenDecimal, 6);
  assert.equal(decoded.preMigrationTokenSupply.toString(), '1000000000000000');
  assert.equal(decoded.poolFees.baseFee.cliffFeeNumerator.toString(), '900000000');
  bytes[0] ^= 1;
  assert.throws(() => decodeConfig(bytes), /discriminator/);
});
