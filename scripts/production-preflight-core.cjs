/* Read-only public configuration checks. No signer, keypair, relay or deployment client. */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const workspace = path.resolve(__dirname, '..'),
  app = createRequire(path.join(workspace, 'scaffolds/fun-launch/package.json'));
const { PublicKey } = app('@solana/web3.js'),
  { BorshCoder } = app('@coral-xyz/anchor');
const { convertIdlToCamelCase } = app('@coral-xyz/anchor/dist/cjs/idl.js');
const sdk = app('@meteora-ag/dynamic-bonding-curve-sdk');
const { inspectLaunchConfig } = require('./launch-policy.cjs');
const { NETWORK_GENESIS, localValidatorPolicy } = require('./network-policy.cjs');
const { canonical, readSchemaCatalog, compareSchema, sha } = require('./production-schema.cjs');
const ROLES = ['dbc', 'damm', 'metadata'];
const { companyWallets } = require('./company-wallets.cjs');
const UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const IMMUTABLE_LOADERS = [
  'BPFLoader1111111111111111111111111111111111',
  'BPFLoader2111111111111111111111111111111111',
].map((value) => new PublicKey(value));
const HASH = /^[a-f0-9]{64}$/;
const coder = new BorshCoder(convertIdlToCamelCase(sdk.DynamicBondingCurveIdl));
const programIds = {
  dbc: sdk.DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58(),
  damm: sdk.DAMM_V2_PROGRAM_ID.toBase58(),
  metadata: sdk.METAPLEX_PROGRAM_ID.toBase58(),
};
const pub = (value) => {
  try {
    return typeof value === 'string' && new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
};
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
function validateExpectations(input, { rehearsal = false } = {}) {
  const missing = [],
    invalid = [];
  const required = (value, name, test) => {
    if (value === undefined) missing.push(name);
    else if (!test(value)) invalid.push(name);
  };
  const keys = (value, allowed, name) => {
    if (!object(value)) {
      if (value !== undefined) invalid.push(name);
      return;
    }
    if (Object.keys(value).some((key) => !allowed.includes(key)))
      invalid.push(`${name}.unexpectedFields`);
  };
  if (!object(input)) return { missing: ['independentlyReviewedPublicExpectations'], invalid: [] };
  keys(
    input,
    [
      'version',
      'networkGenesis',
      'siteOrigin',
      'programs',
      'config',
      'company',
      'schemaContractSha256',
      'worker',
    ],
    'expectations'
  );
  required(input.version, 'version', (value) => value === 2);
  required(
    input.networkGenesis,
    'networkGenesis',
    (value) =>
      pub(value) &&
      (rehearsal
        ? !Object.values(NETWORK_GENESIS).includes(value)
        : value === NETWORK_GENESIS['mainnet-beta'])
  );
  required(input.siteOrigin, 'siteOrigin', (value) => {
    try {
      const url = new URL(value);
      return (
        !url.username &&
        !url.password &&
        url.origin === value &&
        (rehearsal ? ['http:', 'https:'].includes(url.protocol) : url.protocol === 'https:')
      );
    } catch {
      return false;
    }
  });
  keys(input.programs, ROLES, 'programs');
  for (const role of ROLES) {
    const program = input.programs?.[role];
    keys(program, ['address', 'upgradeAuthority', 'deployedDataSha256'], `programs.${role}`);
    required(program?.address, `programs.${role}.address`, pub);
    required(
      program?.upgradeAuthority,
      `programs.${role}.upgradeAuthority`,
      (value) => value === null || pub(value)
    );
    required(
      program?.deployedDataSha256,
      `programs.${role}.deployedDataSha256`,
      (value) => typeof value === 'string' && HASH.test(value)
    );
    if (program?.address && program.address !== programIds[role])
      invalid.push(`programs.${role}.canonicalAddress`);
  }
  if (
    input.programs &&
    new Set(ROLES.map((role) => input.programs[role]?.address).filter(Boolean)).size !==
      ROLES.filter((role) => input.programs[role]?.address).length
  )
    invalid.push('programs.uniqueAddresses');
  keys(
    input.config,
    ['address', 'digest', 'feeClaimer', 'leftoverReceiver', 'registryEnabled', 'migrationConfig'],
    'config'
  );
  for (const field of ['address', 'feeClaimer', 'leftoverReceiver'])
    required(input.config?.[field], `config.${field}`, pub);
  required(
    input.config?.digest,
    'config.digest',
    (value) => typeof value === 'string' && HASH.test(value)
  );
  required(
    input.config?.registryEnabled,
    'config.registryEnabled',
    (value) => typeof value === 'boolean'
  );
  keys(input.config?.migrationConfig, ['address', 'digest'], 'config.migrationConfig');
  required(
    input.config?.migrationConfig?.address,
    'config.migrationConfig.address',
    (value) => pub(value) && value === sdk.DAMM_V2_MIGRATION_FEE_ADDRESS[6].toBase58()
  );
  required(
    input.config?.migrationConfig?.digest,
    'config.migrationConfig.digest',
    (value) => typeof value === 'string' && HASH.test(value)
  );
  keys(input.company, ['collector', 'treasury'], 'company');
  for (const field of ['collector', 'treasury'])
    required(input.company?.[field], `company.${field}`, pub);
  if (input.company?.collector && input.company?.treasury) {
    try {
      companyWallets(
        {
          FEE_COLLECTOR_PUBLIC_KEY: input.company.collector,
          TREASURY_PUBLIC_KEY: input.company.treasury,
        },
        input.networkGenesis
      );
    } catch {
      invalid.push('company.ordinaryReviewedWallets');
    }
  }
  if (
    input.config?.feeClaimer !== input.company?.collector ||
    input.config?.leftoverReceiver !== input.company?.treasury
  )
    invalid.push('config.companyRecipients');
  required(
    input.schemaContractSha256,
    'schemaContractSha256',
    (value) => typeof value === 'string' && HASH.test(value)
  );
  keys(
    input.worker,
    ['operatorArtifactSha256', 'schedulerArtifactSha256', 'maxHeartbeatAgeSeconds'],
    'worker'
  );
  for (const field of ['operatorArtifactSha256', 'schedulerArtifactSha256'])
    required(
      input.worker?.[field],
      `worker.${field}`,
      (value) => typeof value === 'string' && HASH.test(value)
    );
  required(
    input.worker?.maxHeartbeatAgeSeconds,
    'worker.maxHeartbeatAgeSeconds',
    (value) => Number.isSafeInteger(value) && value >= 1 && value <= 300
  );
  return { missing: [...new Set(missing)], invalid: [...new Set(invalid)] };
}
function decodeConfig(bytes) {
  return coder.accounts.decode('poolConfig', bytes);
}
function programDataAddress(program) {
  return PublicKey.findProgramAddressSync([program.toBuffer()], UPGRADEABLE)[0];
}
function inspectProgram(address, account, dataAccount, expected) {
  if (!account?.executable) throw new Error('PROGRAM_NOT_EXECUTABLE');
  let bytes,
    authority = null,
    slot = null;
  if (account.owner.equals(UPGRADEABLE)) {
    const derived = programDataAddress(address);
    if (
      account.data.length !== 36 ||
      account.data.readUInt32LE(0) !== 2 ||
      !new PublicKey(account.data.subarray(4, 36)).equals(derived) ||
      !dataAccount?.owner.equals(UPGRADEABLE) ||
      dataAccount.executable ||
      dataAccount.data.length < 49 ||
      dataAccount.data.readUInt32LE(0) !== 3
    )
      throw new Error('PROGRAM_DATA_BINDING_INVALID');
    const option = dataAccount.data[12];
    if (option !== 0 && option !== 1) throw new Error('PROGRAM_UPGRADE_AUTHORITY_INVALID');
    authority = option === 1 ? new PublicKey(dataAccount.data.subarray(13, 45)).toBase58() : null;
    slot = dataAccount.data.readBigUInt64LE(4).toString();
    bytes = dataAccount.data.subarray(45);
  } else if (IMMUTABLE_LOADERS.some((loader) => account.owner.equals(loader))) bytes = account.data;
  else throw new Error('PROGRAM_LOADER_UNSUPPORTED');
  if (bytes.length > 10 * 1024 * 1024 || bytes.subarray(0, 4).toString('hex') !== '7f454c46')
    throw new Error('PROGRAM_EXECUTABLE_DATA_INVALID');
  const digest = sha(bytes);
  return {
    ok: authority === expected.upgradeAuthority && digest === expected.deployedDataSha256,
    address: address.toBase58(),
    upgradeAuthority: authority,
    deployedDataSha256: digest,
    deployedAtSlot: slot,
    authorityMatches: authority === expected.upgradeAuthority,
    codeMatches: digest === expected.deployedDataSha256,
  };
}
function localInventory() {
  const files = [
    'scripts/audit-launch-config.mjs',
    'scripts/register-launch-config.mjs',
    'scripts/financial-health.cjs',
    'scripts/build-financial-worker.mjs',
    'scripts/production-preflight-core.cjs',
    'scripts/operator-start.cjs',
    'docs/mainnet-authorities.public.json',
    'scaffolds/fun-launch/src/constants/launchPolicy.json',
    'scaffolds/fun-launch/src/constants/bondPolicy.json',
  ];
  const inventory = {
    nodeVersion: process.versions.node,
    readOnly: true,
    publicSourceFiles: files.map((file) => {
      try {
        return { file, sha256: sha(fs.readFileSync(path.join(workspace, file))) };
      } catch {
        return { file, missing: true };
      }
    }),
    migrations: [],
  };
  inventory.migrationSourceNormalization = 'LF';
  inventory.migrations = fs
    .readdirSync(path.join(workspace, 'scripts/migrations'))
    .filter((file) => /^\d{3}-[a-z0-9-]+\.sql$/.test(file))
    .sort()
    .map((file) => ({
      file,
      sha256: sha(
        fs
          .readFileSync(path.join(workspace, 'scripts/migrations', file), 'utf8')
          .replace(/\r\n/g, '\n')
      ),
    }));
  for (const [name, file, limit] of [
    ['schemaContract', 'scripts/production-schema-contract.json', 1024 * 1024],
    ['operatorArtifact', 'scaffolds/fun-launch/.worker/ops.cjs', 50 * 1024 * 1024],
    ['schedulerArtifact', 'scaffolds/fun-launch/.worker/scheduler.cjs', 50 * 1024 * 1024],
  ]) {
    try {
      const full = path.join(workspace, file),
        stat = fs.lstatSync(full);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > limit) throw new Error('Capacity');
      inventory[name] = { file, sha256: sha(fs.readFileSync(full)) };
    } catch {
      inventory[name] = { file, missing: true };
    }
  }
  return inventory;
}
function check(checks, id, ok, details) {
  checks.push({ id, status: ok ? 'pass' : 'fail', ...(details ? { details } : {}) });
  return ok;
}
function publicFailure(checks, id, code) {
  checks.push({ id, status: 'unknown', code });
}
function baseReport(rehearsal) {
  return {
    version: 2,
    policy: 'wallet-v1',
    requiresNativeProgram: false,
    mode: rehearsal ? 'isolated-rehearsal' : 'production',
    checkedAt: new Date().toISOString(),
    readOnly: true,
    technicalChecksPassed: false,
    financialReleaseReady: false,
    mainnetGateOpened: false,
    // Owner decisions are context, never substitutes for account/code checks or signing controls.
    ownerDecisions: {
      recordedOn: '2026-10-28',
      reference: 'docs/MAINNET-OWNER-DECISIONS.md',
      feeBasis: 'actual-received-owned-position-income',
      independentSecurityReview: 'owner-declined',
      authorityController: 'project-owner',
      intendedAuthorityReference: 'docs/mainnet-authorities.public.json',
      operationsOwner: 'project-owner',
    },
    checks: [],
    externalRequirements: [
      {
        id: 'independent-security-review',
        status: 'owner-declined',
        reason:
          'The owner declined an outside audit on 2026-10-28. No independent audit is claimed; internal checks and this decision do not prove custody or production readiness.',
      },
      {
        id: 'authority-custody-and-governance',
        status: 'unknown',
        reason:
          'The owner supplied intended production authorities in docs/mainnet-authorities.public.json; actual on-chain binding, signing custody and recovery controls still require verification.',
      },
      {
        id: 'external-signer-and-relay-liveness',
        status: 'unknown',
        reason: 'Unsigned planner heartbeat cannot prove external signer or relay availability.',
      },
      {
        id: 'archive-service-retention-and-recovery',
        status: 'unknown',
        reason:
          'A current RPC read does not prove future retention, backup restoration or incident response.',
      },
      {
        id: 'total-pool-fee-destination-policy',
        status: 'owner-approved',
        reason:
          'On 2026-10-28 the owner approved allocating actual income received by the permanently owned position, with outside LP dilution excluded from payable income.',
      },
      {
        id: 'production-deployment-and-funded-acceptance',
        status: 'unknown',
        reason:
          'Local artifacts and this process environment do not attest the deployed web/worker release or funded production rehearsal.',
      },
    ],
    sideEffects: {
      recordsWritten: 0,
      transactionsBroadcast: 0,
      signaturesCreated: 0,
      privateKeyFilesRead: 0,
      keysGenerated: 0,
    },
  };
}
async function collectDatabasePreflight({
  pool,
  expected,
  contract,
  checks,
  observedSlot,
  report,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '10000ms'");
    await client.query('SET LOCAL search_path = pg_catalog, public');
    const readOnly = (await client.query('SHOW transaction_read_only')).rows[0]
      ?.transaction_read_only;
    check(checks, 'database.readOnly', readOnly === 'on');
    if (readOnly !== 'on') return;
    const tls = (await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()'))
      .rows[0]?.ssl;
    check(checks, 'database.tls', tls === true);
    if (tls !== true) return;
    const actual = await readSchemaCatalog(client, {
        tables: contract.catalog.tables,
        functions: contract.catalog.functions.map((row) => row.name),
      }),
      issues = compareSchema(contract.catalog, actual);
    check(checks, 'database.schema', issues.length === 0, { issues });
    if (issues.length) return;
    const row = (
      await client.query(
        `SELECT policy_version,expected_fee_claimer,expected_leftover_receiver,config_digest,enabled_for_launch,verified_slot::text FROM public.launch_configs WHERE network_genesis=$1 AND config_key=$2`,
        [expected.networkGenesis, expected.config.address]
      )
    ).rows[0];
    const registryMatches = check(
      checks,
      'database.registry',
      !!row &&
        row.policy_version === report.policy &&
        row.expected_fee_claimer === expected.config.feeClaimer &&
        row.expected_leftover_receiver === expected.config.leftoverReceiver &&
        row.config_digest === expected.config.digest &&
        row.enabled_for_launch === expected.config.registryEnabled &&
        /^\d+$/.test(row.verified_slot) &&
        BigInt(row.verified_slot) <= BigInt(observedSlot)
    );
    check(checks, 'config.launchesEnabled', registryMatches && row.enabled_for_launch === true, {
      existingFundedClaimsSeparate: true,
    });
    const heartbeat = (
      await client.query(
        `SELECT last_started_at,last_completed_at,last_progress_at,last_status,last_processed,last_failed,clock_timestamp() AS database_now FROM public.wallet_scheduler_state WHERE network_genesis=$1 AND collector=$2`,
        [expected.networkGenesis, expected.company.collector]
      )
    ).rows[0];
    let age = null,
      healthy = false;
    if (heartbeat) {
      const now = new Date(heartbeat.database_now).getTime(),
        values = [
          heartbeat.last_started_at,
          heartbeat.last_completed_at,
          heartbeat.last_progress_at,
        ]
          .filter(Boolean)
          .map((value) => new Date(value).getTime()),
        last = Math.max(...values);
      age = (now - last) / 1000;
      healthy =
        values.every(Number.isFinite) &&
        age >= -1 &&
        age <= expected.worker.maxHeartbeatAgeSeconds &&
        ['running', 'completed'].includes(heartbeat.last_status) &&
        heartbeat.last_failed === 0 &&
        Number.isSafeInteger(heartbeat.last_processed) &&
        heartbeat.last_processed >= 0;
    }
    check(checks, 'worker.unsignedPlannerHeartbeat', healthy, {
      code: healthy
        ? 'UNSIGNED_PLANNER_RECENT'
        : !heartbeat
          ? 'PLANNER_HEARTBEAT_MISSING'
          : !['running', 'completed'].includes(heartbeat.last_status)
            ? 'PLANNER_STOPPED_OR_FAILED'
            : heartbeat.last_failed > 0
              ? 'PLANNER_HAS_FAILED_COINS'
              : !Number.isFinite(age) || age < -1
                ? 'PLANNER_HEARTBEAT_INVALID'
                : 'PLANNER_HEARTBEAT_STALE',
      ageSeconds: Number.isFinite(age) ? age : null,
      provesExternalSigner: false,
    });
  } finally {
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }
}
async function collectProductionPreflight({
  expected,
  env = process.env,
  rpc,
  pool,
  contract,
  inventory = localInventory(),
  rehearsal = false,
  configDecoder = decodeConfig,
  databaseRequested = !!pool,
} = {}) {
  const report = baseReport(rehearsal),
    checks = report.checks,
    validation = validateExpectations(expected, { rehearsal });
  report.inventory = inventory;
  report.inputs = { missing: validation.missing, invalid: validation.invalid };
  if (validation.missing.length || validation.invalid.length) return report;
  const bindings = [
    ['POOL_CONFIG_KEY', expected.config.address],
    ['NEXT_PUBLIC_POOL_CONFIG_KEY', expected.config.address],
    ['FEE_COLLECTOR_PUBLIC_KEY', expected.company.collector],
    ['TREASURY_PUBLIC_KEY', expected.company.treasury],
    ['NEXT_PUBLIC_SITE_URL', expected.siteOrigin],
  ];
  report.inputs.missingEnvironment = [
    ...bindings.map(([name]) => name),
    'NODE_ENV',
    'NEXT_PUBLIC_NETWORK',
    'WALLET_WORKER_ENABLED',
    ...(!rpc ? ['RPC_URL'] : []),
    ...(databaseRequested && !pool ? ['DATABASE_URL'] : []),
  ].filter((name) => !env[name]);
  if (rehearsal) {
    let allowed = false;
    try {
      allowed =
        localValidatorPolicy(env) &&
        env.LOCAL_VALIDATOR_GENESIS_HASH === expected.networkGenesis &&
        env.NEXT_PUBLIC_SITE_URL === expected.siteOrigin;
    } catch {}
    check(checks, 'runtime.isolatedRehearsal', allowed);
    if (!allowed) return report;
  } else
    check(
      checks,
      'runtime.productionConfiguration',
      env.NODE_ENV === 'production' &&
        env.NEXT_PUBLIC_NETWORK === 'mainnet-beta' &&
        !env.LOCAL_VALIDATOR_GENESIS_HASH &&
        env.LOCAL_VALIDATOR_ENABLED !== 'true' &&
        !env.NEXT_PUBLIC_LOCAL_VALIDATOR_RPC_URL
    );
  check(
    checks,
    'runtime.publicBindings',
    bindings.every(([name, value]) => env[name] === value),
    { mismatched: bindings.filter(([name, value]) => env[name] !== value).map(([name]) => name) }
  );
  check(checks, 'runtime.mainnetGateRemainsClosed', env.MAINNET_TRADING_ENABLED !== 'true');
  check(checks, 'runtime.demoDisabled', env.NEXT_PUBLIC_DEMO_LAUNCHES !== 'true');
  check(checks, 'runtime.workerConfigured', env.WALLET_WORKER_ENABLED === 'true');
  check(
    checks,
    'local.operatorArtifact',
    inventory.operatorArtifact?.sha256 === expected.worker.operatorArtifactSha256
  );
  check(
    checks,
    'local.schedulerArtifact',
    inventory.schedulerArtifact?.sha256 === expected.worker.schedulerArtifactSha256
  );
  const contractMatches = check(
    checks,
    'local.schemaContract',
    contract?.version === 1 &&
      contract.sourceNormalization === 'LF' &&
      Array.isArray(contract.catalog?.tables) &&
      contract.catalog.tables.length > 0 &&
      inventory.schemaContract?.sha256 === expected.schemaContractSha256 &&
      canonical(contract.migrations) === canonical(inventory.migrations)
  );
  if (!rpc) {
    publicFailure(checks, 'rpc', 'RPC_URL_MISSING');
    return report;
  }
  let batchSlot = 0;
  try {
    if (
      !check(
        checks,
        'rpc.independentlyPinnedGenesis',
        (await rpc.getGenesisHash()) === expected.networkGenesis
      )
    )
      return report;
    const programs = ROLES.map((role) => new PublicKey(expected.programs[role].address)),
      configKey = new PublicKey(expected.config.address);
    const result = await rpc.getMultipleAccountsInfoAndContext(
      [
        ...programs,
        ...programs.map(programDataAddress),
        configKey,
        new PublicKey(expected.config.migrationConfig.address),
      ],
      { commitment: 'finalized' }
    );
    batchSlot = result.context.slot;
    if (!Number.isSafeInteger(batchSlot) || batchSlot < 0 || result.value.length !== 8)
      throw new Error('RPC_SNAPSHOT_INVALID');
    report.finalizedSnapshotSlot = batchSlot;
    ROLES.forEach((role, index) => {
      try {
        const observed = inspectProgram(
          programs[index],
          result.value[index],
          result.value[index + 3],
          expected.programs[role]
        );
        check(checks, `program.${role}`, observed.ok, observed);
      } catch (error) {
        const code = [
          'PROGRAM_NOT_EXECUTABLE',
          'PROGRAM_DATA_BINDING_INVALID',
          'PROGRAM_UPGRADE_AUTHORITY_INVALID',
          'PROGRAM_LOADER_UNSUPPORTED',
          'PROGRAM_EXECUTABLE_DATA_INVALID',
        ].includes(error.message)
          ? error.message
          : 'PROGRAM_READ_INVALID';
        checks.push({ id: `program.${role}`, status: 'fail', code });
      }
    });
    const configAccount = result.value[6];
    const configValid = check(
      checks,
      'config.fullDataIdentity',
      !!configAccount &&
        !configAccount.executable &&
        configAccount.owner.equals(programs[0]) &&
        sha(configAccount.data) === expected.config.digest
    );
    check(
      checks,
      'config.independentCompanyRecipients',
      expected.company.collector === expected.config.feeClaimer &&
        expected.config.leftoverReceiver === expected.company.treasury
    );
    if (configValid) {
      try {
        const decoded = configDecoder(configAccount.data),
          economicPolicy = decoded.activationType === 0 ? 'bond-v1' : 'wallet-v1',
          issues = inspectLaunchConfig(decoded, {
            feeClaimer: expected.config.feeClaimer,
            leftoverReceiver: expected.config.leftoverReceiver,
            policyVersion: economicPolicy,
          });
        check(checks, 'config.reviewedPolicy', issues.length === 0, {
          fields: issues.map((issue) => issue.field),
        });
        if (issues.length === 0) report.policy = economicPolicy;
        report.scheduledEndpointNumerator = sdk
          .getFeeSchedulerMinBaseFeeNumerator(
            decoded.poolFees.baseFee.cliffFeeNumerator,
            decoded.poolFees.baseFee.firstFactor,
            decoded.poolFees.baseFee.thirdFactor,
            decoded.poolFees.baseFee.baseFeeMode
          )
          .toString();
      } catch {
        checks.push({ id: 'config.reviewedPolicy', status: 'fail', code: 'CONFIG_DECODE_FAILED' });
      }
    }
    const migration = result.value[7];
    check(
      checks,
      'config.canonicalMigrationConfig',
      !!migration &&
        !migration.executable &&
        migration.owner.equals(programs[1]) &&
        sha(migration.data) === expected.config.migrationConfig.digest
    );
    check(
      checks,
      'rpc.genesisStableAcrossReads',
      (await rpc.getGenesisHash()) === expected.networkGenesis
    );
  } catch {
    publicFailure(checks, 'rpc.finalizedPublicAccounts', 'RPC_READ_FAILED');
  }
  if (pool && contractMatches && batchSlot > 0) {
    try {
      await collectDatabasePreflight({
        pool,
        expected,
        contract,
        checks,
        observedSlot: batchSlot,
        report,
      });
    } catch {
      publicFailure(checks, 'database', 'DATABASE_READ_FAILED');
    }
  } else
    publicFailure(
      checks,
      'database',
      pool
        ? 'DATABASE_CHECK_PREREQUISITE_MISSING'
        : databaseRequested
          ? 'DATABASE_URL_MISSING'
          : 'DATABASE_READS_NOT_REQUESTED'
    );
  report.technicalChecksPassed =
    checks.length > 0 && checks.every((value) => value.status === 'pass');
  return report;
}
module.exports = {
  collectProductionPreflight,
  collectDatabasePreflight,
  validateExpectations,
  localInventory,
  decodeConfig,
  inspectProgram,
  programDataAddress,
  programIds,
  UPGRADEABLE,
};
