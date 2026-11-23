const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  { createRequire } = require('node:module'),
  { spawnSync } = require('node:child_process');
const app = createRequire(path.resolve(__dirname, '../scaffolds/fun-launch/package.json')),
  { PublicKey, Keypair, SystemProgram, Transaction } = app('@solana/web3.js'),
  { BorshCoder } = app('@coral-xyz/anchor'),
  { convertIdlToCamelCase } = app('@coral-xyz/anchor/dist/cjs/idl.js'),
  BN = app('bn.js'),
  sdk = app('@meteora-ag/dynamic-bonding-curve-sdk');
const {
    prepareBootstrap,
    estimateBootstrap,
    sha,
    MAINNET,
    loadAbi,
    readOnlyRpcFetch,
    redactBootstrapError,
    BootstrapError,
    readBoundedFile,
  } = require('./mainnet-bootstrap-core.cjs'),
  { UPGRADEABLE, programDataAddress } = require('./production-preflight-core.cjs');
const abi = loadAbi('client'),
  clone = (value) => JSON.parse(JSON.stringify(value)),
  pub = (seed) => Keypair.fromSeed(Buffer.alloc(32, seed)).publicKey;
test('rotating the Meteora company wallet leaves the recorded native vault authorities unchanged', () => {
  const owner = require('../docs/mainnet-authorities.public.json');
  const native = require('./mainnet-bootstrap-core.cjs').authorities(owner);
  assert.equal(native.operator, owner.vault.operator);
  assert.equal(native.governor, owner.vault.governor);
  assert.equal(native.upgradeAuthority, owner.upgradeAuthority);
  assert.notEqual(native.operator, owner.company.collector);
});
function configBytes(feeAuthority, treasury) {
  const idl = convertIdlToCamelCase(sdk.DynamicBondingCurveIdl),
    coder = new BorshCoder(idl);
  const zero = (type) => {
    if (typeof type === 'string') {
      if (type === 'pubkey') return PublicKey.default;
      if (['u64', 'i64', 'u128', 'i128', 'u256', 'i256'].includes(type)) return new BN(0);
      return type === 'bool' ? false : 0;
    }
    if (type.array) return Array.from({ length: type.array[1] }, () => zero(type.array[0]));
    if (type.defined)
      return Object.fromEntries(
        idl.types
          .find((v) => v.name === type.defined.name)
          .type.fields.map((field) => [field.name, zero(field.type)])
      );
    throw Error('Unknown fixture IDL');
  };
  const config = zero({ defined: { name: 'poolConfig' } });
  const desired = {
    quoteMint: new PublicKey('So11111111111111111111111111111111111111112'),
    feeClaimer: feeAuthority,
    leftoverReceiver: treasury,
    poolFees: {
      baseFee: {
        cliffFeeNumerator: 900000000,
        baseFeeMode: 1,
        firstFactor: 9,
        secondFactor: 3,
        thirdFactor: 3782,
      },
      dynamicFee: { initialized: 0 },
    },
    collectFeeMode: 0,
    activationType: 1,
    tokenDecimal: 6,
    tokenType: 0,
    tokenUpdateAuthority: 1,
    preMigrationTokenSupply: '1000000000000000',
    postMigrationTokenSupply: '1000000000000000',
    migrationQuoteThreshold: '80000000000',
    migrationOption: 1,
    migrationFeeOption: 6,
    migratedCollectFeeMode: 0,
    migratedDynamicFee: 0,
    migratedPoolFeeBps: 125,
    migratedPoolBaseFeeMode: 0,
    creatorTradingFeePercentage: 0,
    partnerPermanentLockedLiquidityPercentage: 100,
    partnerLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 0,
    creatorLiquidityPercentage: 0,
    poolCreationFee: 0,
    migrationFeePercentage: 0,
    creatorMigrationFeePercentage: 0,
  };
  const merge = (into, from) => {
    for (const [key, value] of Object.entries(from)) {
      if (BN.isBN(into[key])) into[key] = new BN(String(value));
      else if (value && typeof value === 'object' && !(value instanceof PublicKey))
        merge(into[key], value);
      else into[key] = value;
    }
  };
  merge(config, desired);
  const buffer = Buffer.alloc(16384),
    length = coder.accounts.accountLayouts.get('poolConfig').layout.encode(config, buffer);
  return Buffer.concat([
    coder.accounts.accountDiscriminator('poolConfig'),
    buffer.subarray(0, length),
  ]);
}
function fixture() {
  const program = pub(8),
    config = pub(9),
    governor = pub(10),
    operator = pub(11),
    treasury = pub(12),
    elf = Buffer.concat([Buffer.from('7f454c46', 'hex'), Buffer.alloc(252, 3)]),
    pd = programDataAddress(program),
    addresses = abi.vaultAddresses(program, config),
    approval = abi.configApprovalAddress(program, config);
  const owner = {
    version: 1,
    recordedOn: '2026-10-28',
    networkGenesis: MAINNET,
    controller: 'project-owner',
    vault: {
      governor: governor.toBase58(),
      operator: operator.toBase58(),
      treasury: treasury.toBase58(),
    },
    upgradeAuthority: governor.toBase58(),
    status: 'owner-provided-intended-authorities',
    custodyVerified: false,
    productionSignerConfigured: false,
  };
  const programData = Buffer.alloc(45 + elf.length);
  programData.writeUInt32LE(3);
  programData.writeBigUInt64LE(1n, 4);
  programData[12] = 1;
  governor.toBuffer().copy(programData, 13);
  elf.copy(programData, 45);
  const programBytes = Buffer.alloc(36);
  programBytes.writeUInt32LE(2);
  pd.toBuffer().copy(programBytes, 4);
  const bytes = configBytes(addresses.feeAuthority, treasury),
    values = [
      { owner: UPGRADEABLE, executable: true, data: programBytes },
      { owner: UPGRADEABLE, executable: false, data: programData },
      { owner: sdk.DYNAMIC_BONDING_CURVE_PROGRAM_ID, executable: false, data: bytes },
      null,
      null,
    ];
  const review = {
    version: 1,
    networkGenesis: MAINNET,
    program: {
      address: program.toBase58(),
      upgradeAuthority: owner.upgradeAuthority,
      elfSha256: sha(elf),
      deployedDataSha256: sha(elf),
    },
    config: { address: config.toBase58(), digest: sha(bytes) },
  };
  const calls = [];
  const rpc = {
    getGenesisHash: async () => {
      calls.push('genesis');
      return MAINNET;
    },
    getSlot: async () => 123,
    getMinimumBalanceForRentExemption: async (size, commitment) => {
      calls.push(['rent', size, commitment]);
      return 1000 + size * 7;
    },
    getMultipleAccountsInfoAndContext: async (keys, options) => {
      calls.push(['accounts', keys.map((key) => key.toBase58()), options]);
      return { context: { slot: 123 }, value: values };
    },
    getLatestBlockhashAndContext: async (options) => {
      calls.push(['blockhash', options]);
      return {
        context: { slot: 124 },
        value: { blockhash: pub(15).toBase58(), lastValidBlockHeight: 200 },
      };
    },
    getFeeForMessage: async (message, commitment) => {
      calls.push(['fee', commitment, message.header.numRequiredSignatures]);
      return { context: { slot: 124 }, value: 5000 };
    },
    sendTransaction: () => assert.fail('MUST NEVER SEND'),
    sendRawTransaction: () => assert.fail('MUST NEVER SEND'),
    requestAirdrop: () => assert.fail('MUST NEVER AIRDROP'),
  };
  const settings = (change = {}) => {
    const data = Buffer.alloc(107);
    data.write('RSET0001');
    data[8] = 1;
    data[9] = PublicKey.findProgramAddressSync([Buffer.from('settings')], program)[1];
    data[10] = 1;
    governor.toBuffer().copy(data, 11);
    operator.toBuffer().copy(data, 43);
    treasury.toBuffer().copy(data, 75);
    values[3] = { owner: program, executable: false, data, ...change };
  };
  const approved = () => {
    const data = Buffer.alloc(74);
    data.write('RCONF001');
    data[8] = 1;
    data[9] = PublicKey.findProgramAddressSync(
      [Buffer.from('config'), config.toBuffer()],
      program
    )[1];
    config.toBuffer().copy(data, 10);
    Buffer.from(sha(bytes), 'hex').copy(data, 42);
    values[4] = { owner: program, executable: false, data };
  };
  return {
    owner,
    review,
    elf,
    rpc,
    calls,
    program,
    config,
    governor,
    operator,
    treasury,
    values,
    settings,
    approved,
    addresses,
    approval,
  };
}
test('prepares one unsigned canonical atomic init/approve/pause with exact reviewed owner roles and recovery context', async () => {
  const f = fixture(),
    result = await prepareBootstrap(f),
    tx = Transaction.from(Buffer.from(result.transactions[0].transactionBase64, 'base64'));
  assert.equal(result.finalPaused, true);
  assert.equal(result.mainnetGateOpened, false);
  assert.equal(result.financialReleaseReady, false);
  assert.equal(result.custodyVerified, false);
  assert.deepEqual(result.transactions[0].instructionNames, [
    'initialize_unpaused',
    'approve_config',
    'set_paused_true',
  ]);
  assert.equal(tx.signatures.length, 1);
  assert.equal(tx.signatures[0].signature, null);
  assert.equal(result.transactions[0].messageDigest, sha(tx.serializeMessage()));
  assert.equal(result.transactions[0].preparedSlot, 124);
  assert.equal(result.transactions[0].lastValidBlockHeight, 200);
  const expected = [
    abi.initializeVaultInstruction({
      programId: f.program,
      governor: f.governor,
      operator: f.operator,
      treasury: f.treasury,
      paused: false,
    }),
    abi.approveConfigInstruction(f.program, f.governor, f.config),
    abi.setPausedInstruction(f.program, f.governor, true),
  ];
  for (const [index, instruction] of tx.instructions.entries()) {
    assert(instruction.programId.equals(expected[index].programId));
    assert(instruction.data.equals(expected[index].data));
    assert.deepEqual(
      instruction.keys,
      expected[index].keys.map((key) => ({
        ...key,
        isWritable:
          key.pubkey.equals(f.governor) ||
          key.pubkey.equals(f.addresses.settings) ||
          key.pubkey.equals(f.approval),
      }))
    );
  }
  assert.equal(result.sideEffects.transactionsBroadcast, 0);
  assert.equal(result.sideEffects.signaturesCreated, 0);
  assert(
    f.calls.every(
      (call) => !Array.isArray(call) || ['accounts', 'blockhash', 'fee'].includes(call[0])
    )
  );
});
test('existing settings must have all exact roles and remain paused before preparing atomic approval', async () => {
  const f = fixture();
  f.settings();
  const result = await prepareBootstrap(f);
  assert.deepEqual(result.transactions[0].instructionNames, [
    'set_paused_false',
    'approve_config',
    'set_paused_true',
  ]);
  for (const offset of [11, 43, 75]) {
    const g = fixture();
    g.settings();
    pub(22).toBuffer().copy(g.values[3].data, offset);
    await assert.rejects(prepareBootstrap(g), /EXISTING_SETTINGS_ROLES_MISMATCH/);
  }
  const unpaused = fixture();
  unpaused.settings();
  unpaused.values[3].data[10] = 0;
  await assert.rejects(prepareBootstrap(unpaused), /MUST_BE_PAUSED/);
});
test('idempotent already-approved recovery never emits a transaction or an unpause', async () => {
  const f = fixture();
  f.settings();
  f.approved();
  const result = await prepareBootstrap(f);
  assert.equal(result.status, 'already-prepared-on-chain');
  assert.deepEqual(result.transactions, []);
  assert(!f.calls.some((call) => Array.isArray(call) && call[0] === 'blockhash'));
  f.values[4].data[42] ^= 1;
  await assert.rejects(prepareBootstrap(f), /EXISTING_APPROVAL_MISMATCH/);
});
test('missing independent pins and wrong intended roles fail before any RPC observation', async () => {
  const f = fixture();
  await assert.rejects(
    prepareBootstrap({ ...f, review: undefined }),
    /INDEPENDENT_PROGRAM_AND_CONFIG_PINS_REQUIRED/
  );
  assert.equal(f.calls.length, 0);
  const changed = clone(f.owner);
  changed.upgradeAuthority = pub(30).toBase58();
  await assert.rejects(prepareBootstrap({ ...f, owner: changed }), /INITIAL_GOVERNOR/);
  assert.equal(f.calls.length, 0);
  const badReview = clone(f.review);
  badReview.program.upgradeAuthority = pub(30).toBase58();
  await assert.rejects(prepareBootstrap({ ...f, review: badReview }), /REVIEWED_PINS_INVALID/);
  assert.equal(f.calls.length, 0);
});
test('rejects first-come initialization takeover, immutable loader and noncanonical ProgramData bindings', async () => {
  const f = fixture();
  pub(25).toBuffer().copy(f.values[1].data, 13);
  await assert.rejects(prepareBootstrap(f), /PROGRAM_UPGRADE_AUTHORITY_MISMATCH/);
  for (const alter of [
    (g) => {
      pub(20).toBuffer().copy(g.values[0].data, 4);
    },
    (g) => {
      g.values[1].owner = SystemProgram.programId;
    },
    (g) => {
      g.values[0].executable = false;
    },
    (g) => {
      g.values[1].data[12] = 0;
    },
    (g) => {
      g.values[0].owner = new PublicKey('BPFLoader2111111111111111111111111111111111');
    },
  ]) {
    const g = fixture();
    alter(g);
    await assert.rejects(prepareBootstrap(g));
  }
});
test('wrong reviewed source/deployed ELF hashes fail without accepting observed code as expectations', async () => {
  const f = fixture();
  f.review.program.elfSha256 = 'a'.repeat(64);
  await assert.rejects(prepareBootstrap(f), /REVIEWED_ELF_HASH_INVALID/);
  assert.equal(f.calls.length, 0);
  const g = fixture();
  g.values[1].data[60] ^= 1;
  await assert.rejects(prepareBootstrap(g), /DEPLOYED_PROGRAM_HASH_MISMATCH/);
  const h = fixture();
  h.review.program.deployedDataSha256 = 'b'.repeat(64);
  await assert.rejects(prepareBootstrap(h), /DEPLOYED_PROGRAM_HASH_MISMATCH/);
});
test('DBC config owner, immutable digest, fee-authority PDA, treasury and policy are all pinned', async () => {
  for (const mutate of [
    (f) => {
      f.values[2].owner = f.program;
    },
    (f) => {
      f.review.config.digest = 'b'.repeat(64);
    },
    (f) => {
      f.values[2].data = configBytes(pub(25), f.treasury);
      f.review.config.digest = sha(f.values[2].data);
    },
    (f) => {
      f.values[2].data = configBytes(f.addresses.feeAuthority, pub(25));
      f.review.config.digest = sha(f.values[2].data);
    },
    (f) => {
      f.values[2].data[0] ^= 1;
      f.review.config.digest = sha(f.values[2].data);
    },
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(prepareBootstrap(f));
  }
});
test('rejects network switches before and after read-only preparation and stale recovery context', async () => {
  const f = fixture();
  f.rpc.getGenesisHash = async () => pub(26).toBase58();
  await assert.rejects(prepareBootstrap(f), /RPC_IS_NOT_MAINNET/);
  assert.equal(f.calls.length, 0);
  const g = fixture();
  let reads = 0;
  g.rpc.getGenesisHash = async () => (++reads === 1 ? MAINNET : pub(26).toBase58());
  await assert.rejects(prepareBootstrap(g), /RPC_IS_NOT_MAINNET/);
  const h = fixture();
  h.rpc.getLatestBlockhashAndContext = async () => ({
    context: { slot: 122 },
    value: { blockhash: pub(15).toBase58(), lastValidBlockHeight: 200 },
  });
  await assert.rejects(prepareBootstrap(h), /PREPARATION_SLOT_TOO_OLD/);
});
test('estimates exact RPC rent at source-derived loader/native sizes, with no fabricated all-in SOL total', async () => {
  const f = fixture(),
    result = await estimateBootstrap({ ...f, elfSha256: sha(f.elf) });
  assert.deepEqual(
    result.rentAccounts.map((row) => [row.account, row.bytes]),
    [
      ['program', 36],
      ['programData', 301],
      ['temporaryBuffer', 293],
      ['settings', 107],
      ['configApproval', 74],
    ]
  );
  assert(result.rentAccounts.every((row) => row.rentLamports === String(1000 + row.bytes * 7)));
  assert.equal(result.transactionFees, null);
  assert.equal(result.rentOnly, true);
  assert.equal(result.maxDataLength, f.elf.length);
  assert.equal(
    result.permanentRentLamports,
    result.rentAccounts
      .filter((row) => !row.temporary)
      .reduce((sum, row) => sum + BigInt(row.rentLamports), 0n)
      .toString()
  );
  assert(f.calls.filter(Array.isArray).every((call) => call[0] === 'rent'));
  const headroom = await estimateBootstrap({
    ...fixture(),
    elfSha256: sha(f.elf),
    maxDataLength: 512,
  });
  assert.equal(headroom.rentAccounts.find((row) => row.account === 'programData').bytes, 557);
});
test('cost mode rejects missing source hash, undersized upgrade capacity, wrong genesis and unsafe rent values', async () => {
  const f = fixture();
  await assert.rejects(estimateBootstrap(f), /REVIEWED_ELF_HASH_INVALID/);
  await assert.rejects(
    estimateBootstrap({ ...f, elfSha256: sha(f.elf), maxDataLength: 255 }),
    /MAX_DATA_LENGTH_INVALID/
  );
  assert.equal(f.calls.length, 0);
  f.rpc.getMinimumBalanceForRentExemption = async () => NaN;
  await assert.rejects(estimateBootstrap({ ...f, elfSha256: sha(f.elf) }), /RENT_RESPONSE_INVALID/);
  f.rpc.getMinimumBalanceForRentExemption = async () => 0;
  await assert.rejects(estimateBootstrap({ ...f, elfSha256: sha(f.elf) }), /RENT_RESPONSE_INVALID/);
  const g = fixture();
  g.rpc.getGenesisHash = async () => pub(26).toBase58();
  await assert.rejects(estimateBootstrap({ ...g, elfSha256: sha(g.elf) }), /RPC_IS_NOT_MAINNET/);
});
test('CLI requires explicit private local output and missing production pins never create artifacts', () => {
  const run = (args) =>
    spawnSync(process.execPath, [path.join(__dirname, 'mainnet-bootstrap.mjs'), ...args], {
      encoding: 'utf8',
    });
  for (const args of [
    [],
    [
      '--prepare',
      '--elf',
      'missing.so',
      '--connection-file',
      '.local/missing.private.json',
      '--output',
      'docs/should-not-exist.private.json',
    ],
    ['--estimate', '--send'],
  ]) {
    const child = run(args);
    assert.equal(child.status, 1);
    const report = JSON.parse(child.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.transactionsBroadcast, 0);
    assert.equal(report.signaturesCreated, 0);
    assert.doesNotMatch(child.stdout, /https:\/\/|secretKey|privateKey/);
  }
});
test('read-only transport blocks single/batched write, signing, airdrop and unknown RPC methods before network access', async () => {
  let requests = 0;
  const guarded = readOnlyRpcFetch(async (_endpoint, init) => {
    requests++;
    assert(init.signal);
    return new Response('{"jsonrpc":"2.0","id":1,"result":123}');
  });
  for (const method of [
    'sendTransaction',
    'sendRawTransaction',
    'requestAirdrop',
    'signTransaction',
    'simulateTransaction',
    'unknown',
  ]) {
    for (const payload of [{ method }, [{ method: 'getSlot' }, { method }]])
      assert.throws(
        () => guarded('https://private-provider.invalid', { body: JSON.stringify(payload) }),
        /RPC_WRITE_OR_UNEXPECTED_METHOD_BLOCKED/
      );
  }
  assert.equal(requests, 0);
  await guarded('https://private-provider.invalid', {
    body: JSON.stringify({ method: 'getSlot' }),
  });
  assert.equal(requests, 1);
  assert.equal(
    redactBootstrapError(new Error('SENSITIVE_API_KEY_VALUE')),
    'BOOTSTRAP_INPUT_OR_READ_ONLY_RPC_FAILED'
  );
  assert.equal(
    redactBootstrapError(new BootstrapError('RPC_IS_NOT_MAINNET')),
    'RPC_IS_NOT_MAINNET'
  );
});
test('CLI preparation without independently provided deployed program/config pins is blocked before ELF/RPC access', () => {
  const output = path.resolve(
    __dirname,
    `../.local/bootstrap-missing-pins-${process.pid}.private.json`
  );
  assert(!fs.existsSync(output));
  const child = spawnSync(
    process.execPath,
    [
      path.join(__dirname, 'mainnet-bootstrap.mjs'),
      '--prepare',
      '--elf',
      '.local/does-not-exist.so',
      '--connection-file',
      '.local/does-not-exist.private.json',
      '--output',
      output,
    ],
    { encoding: 'utf8' }
  );
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).code, 'INDEPENDENT_PROGRAM_AND_CONFIG_PINS_REQUIRED');
  assert(!fs.existsSync(output));
});
test('malformed existing PDA bumps and stale fee snapshots fail closed', async () => {
  const f = fixture();
  f.settings();
  f.values[3].data[9] ^= 1;
  await assert.rejects(prepareBootstrap(f), /EXISTING_SETTINGS_BUMP_MISMATCH/);
  const g = fixture();
  g.settings();
  g.approved();
  g.values[4].data[9] ^= 1;
  await assert.rejects(prepareBootstrap(g), /EXISTING_APPROVAL_MISMATCH/);
  const h = fixture();
  h.rpc.getFeeForMessage = async () => ({ context: { slot: 123 }, value: 5000 });
  await assert.rejects(prepareBootstrap(h), /FEE_SNAPSHOT_TOO_OLD/);
  h.rpc.getFeeForMessage = async () => ({ context: { slot: 124 }, value: null });
  await assert.rejects(prepareBootstrap(h), /PREPARATION_BLOCKHASH_FEE_UNAVAILABLE/);
});
test('RPC reader denies redirects and preserves bounded HTTP error status, headers and JSON schema', async () => {
  const guarded = readOnlyRpcFetch(async (_endpoint, init) => {
    assert.equal(init.redirect, 'error');
    return new Response(
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"provider unavailable"}}',
      {
        status: 503,
        statusText: 'Unavailable',
        headers: { 'content-type': 'application/json', 'retry-after': '5' },
      }
    );
  });
  const response = await guarded('https://private-provider.invalid', {
    body: JSON.stringify({ method: 'getSlot' }),
    redirect: 'follow',
  });
  assert.equal(response.status, 503);
  assert.equal(response.statusText, 'Unavailable');
  assert.equal(response.headers.get('retry-after'), '5');
  assert.deepEqual(await response.json(), {
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32000, message: 'provider unavailable' },
  });
  const redirected = readOnlyRpcFetch(async (_endpoint, init) => {
    assert.equal(init.redirect, 'error');
    return new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid' } });
  });
  await assert.rejects(
    redirected('https://private-provider.invalid', { body: JSON.stringify({ method: 'getSlot' }) }),
    /RPC_REDIRECT_DENIED/
  );
});
test('RPC reader enforces advertised and actual streamed body bounds and cancels oversized streams', async () => {
  const request = { body: JSON.stringify({ method: 'getSlot' }) };
  const declared = readOnlyRpcFetch(
    async () => new Response('x', { headers: { 'content-length': '16777217' } })
  );
  await assert.rejects(
    declared('https://private-provider.invalid', request),
    /RPC_RESPONSE_TOO_LARGE/
  );
  let canceled = false;
  const streamed = readOnlyRpcFetch(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(5));
            controller.enqueue(new Uint8Array(5));
          },
          cancel() {
            canceled = true;
          },
        })
      ),
    { maximumBytes: 8 }
  );
  await assert.rejects(
    streamed('https://private-provider.invalid', request),
    /RPC_RESPONSE_TOO_LARGE/
  );
  assert(canceled);
});
test('RPC deadline remains active after headers and rejects stalled bodies or transports that ignore abort', async () => {
  const request = { body: JSON.stringify({ method: 'getSlot' }) };
  let canceled = false;
  const stalled = readOnlyRpcFetch(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1));
          },
          cancel() {
            canceled = true;
          },
        })
      ),
    { timeoutMs: 20 }
  );
  await assert.rejects(
    stalled('https://private-provider.invalid', request),
    /RPC_RESPONSE_TIMEOUT_OR_ABORTED/
  );
  assert(canceled);
  const hung = readOnlyRpcFetch(() => new Promise(() => {}), { timeoutMs: 20 });
  await assert.rejects(
    hung('https://private-provider.invalid', request),
    /RPC_RESPONSE_TIMEOUT_OR_ABORTED/
  );
});
function mockFileIo({ before = {}, opened = {}, after = {}, bytes = Buffer.from('test') } = {}) {
  const stat = {
    dev: 1n,
    ino: 2n,
    size: 4n,
    mtimeNs: 1n,
    ctimeNs: 1n,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  let position = 0,
    fstats = 0,
    reads = 0,
    closes = 0,
    opens = 0,
    flags;
  const io = {
    lstatSync: () => ({ ...stat, ...before }),
    openSync: (_path, value) => {
      opens++;
      flags = value;
      return 17;
    },
    fstatSync: () => ({ ...stat, ...(fstats++ === 0 ? opened : after) }),
    readSync: (_fd, buffer, offset, length) => {
      reads++;
      const count = Math.min(length, bytes.length - position);
      bytes.copy(buffer, offset, position, position + count);
      position += count;
      return count;
    },
    closeSync: () => {
      closes++;
    },
  };
  return { io, counts: () => ({ reads, closes, opens, flags, position }) };
}
test('bounded FD reader returns exact bytes, sets no-follow/nonblocking flags and always closes', () => {
  const f = mockFileIo();
  assert.equal(readBoundedFile('fixture.json', 4, { io: f.io }).toString(), 'test');
  assert.equal(f.counts().closes, 1);
  assert.equal(f.counts().opens, 1);
  if (fs.constants.O_NOFOLLOW) assert(f.counts().flags & fs.constants.O_NOFOLLOW);
  if (fs.constants.O_NONBLOCK) assert(f.counts().flags & fs.constants.O_NONBLOCK);
  const failed = mockFileIo();
  failed.io.readSync = () => {
    throw new Error('private provider path and credential');
  };
  assert.throws(
    () => readBoundedFile('fixture.json', 4, { io: failed.io }),
    /^Error: INPUT_FILE_READ_FAILED$/
  );
  assert.equal(failed.counts().closes, 1);
});
test('bounded FD reader rejects growth before and during reads, consuming at most maximum+1 bytes', () => {
  const beforeOpen = mockFileIo({ opened: { size: 5n } });
  assert.throws(
    () => readBoundedFile('fixture.json', 4, { io: beforeOpen.io }),
    /INPUT_FILE_TOO_LARGE/
  );
  assert.equal(beforeOpen.counts().reads, 0);
  assert.equal(beforeOpen.counts().closes, 1);
  const growing = mockFileIo({ bytes: Buffer.alloc(100) });
  assert.throws(
    () => readBoundedFile('fixture.json', 4, { io: growing.io }),
    /INPUT_FILE_TOO_LARGE/
  );
  assert.equal(growing.counts().position, 5);
  assert.equal(growing.counts().closes, 1);
  const changed = mockFileIo({ after: { mtimeNs: 2n } });
  assert.throws(
    () => readBoundedFile('fixture.json', 4, { io: changed.io }),
    /INPUT_FILE_CHANGED_DURING_READ/
  );
  assert.equal(changed.counts().closes, 1);
});
test('bounded FD reader rejects symlink/nonregular input and replacement between lstat and open', () => {
  for (const before of [{ isSymbolicLink: () => true }, { isFile: () => false }]) {
    const f = mockFileIo({ before });
    assert.throws(() => readBoundedFile('fixture.json', 4, { io: f.io }), /INPUT_FILE_NOT_REGULAR/);
    assert.equal(f.counts().opens, 0);
  }
  for (const opened of [{ ino: 3n }, { dev: 3n }, { isFile: () => false }]) {
    const f = mockFileIo({ opened });
    assert.throws(
      () => readBoundedFile('fixture.json', 4, { io: f.io }),
      /INPUT_FILE_CHANGED_DURING_OPEN/
    );
    assert.equal(f.counts().reads, 0);
    assert.equal(f.counts().closes, 1);
  }
});
test('--help exits cleanly without RPC calls, secret/ELF reads, key generation, or file output', () => {
  const guard = `import fs from 'node:fs';import crypto from 'node:crypto';
    const read=fs.readFileSync,open=fs.openSync;
    const check=filename=>{if(typeof filename==='string'&&(/\\.private\\.json$|\\.so$|mainnet-authorities\\.public\\.json$/.test(filename)))throw Error('HELP_INPUT_READ_FORBIDDEN');};
    fs.readFileSync=(filename,...rest)=>{check(filename);return read(filename,...rest)};
    fs.openSync=(filename,...rest)=>{check(filename);return open(filename,...rest)};
    fs.writeFileSync=()=>{throw Error('HELP_OUTPUT_FORBIDDEN')};
    globalThis.fetch=()=>{throw Error('HELP_RPC_FORBIDDEN')};
    crypto.randomBytes=()=>{throw Error('HELP_KEY_GENERATION_FORBIDDEN')};
    Object.defineProperty(globalThis,'crypto',{value:{getRandomValues:()=>{throw Error('HELP_KEY_GENERATION_FORBIDDEN')}}});`;
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      `data:text/javascript;base64,${Buffer.from(guard).toString('base64')}`,
      path.join(__dirname, 'mainnet-bootstrap.mjs'),
      '--help',
    ],
    { encoding: 'utf8', env: { ...process.env, RPC_URL: 'this-must-never-be-read' } }
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  for (const text of [
    '--estimate',
    '--prepare',
    '--elf',
    '--elf-sha256',
    '--review-public',
    '--connection-file',
    '--output',
    '.local/*.private.json',
    'Signatures created: 0',
    'Transactions sent: 0',
    'stays paused',
  ])
    assert(child.stdout.includes(text), text);
  assert(!child.stdout.includes('this-must-never-be-read'));
  assert(!child.stdout.includes('"transactionBase64"'));
});
