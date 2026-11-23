/* Read-only production bootstrap planning. This module has no signing or RPC write path. */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const app = Module.createRequire(path.resolve(__dirname, '../scaffolds/fun-launch/package.json'));
const { PublicKey, SystemProgram, Transaction } = app('@solana/web3.js');
const sdk = app('@meteora-ag/dynamic-bonding-curve-sdk');
const { NETWORK_GENESIS } = require('./network-policy.cjs');
const {
  inspectProgram,
  programDataAddress,
  decodeConfig,
  UPGRADEABLE,
} = require('./production-preflight-core.cjs');
const { inspectLaunchConfig } = require('./launch-policy.cjs');
const layout = require('../programs/rinsed-vault/state-layout.json');
const MAINNET = NETWORK_GENESIS['mainnet-beta'];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
class BootstrapError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const fail = (code) => {
  throw new BootstrapError(code);
};
const redactBootstrapError = (error) =>
  error instanceof BootstrapError ? error.code : 'BOOTSTRAP_INPUT_OR_READ_ONLY_RPC_FAILED';
function readOnlyRpcFetch(
  transport = globalThis.fetch,
  { timeoutMs = 15000, maximumBytes = 16 * 1024 * 1024 } = {}
) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 15000 ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 16 * 1024 * 1024
  )
    fail('RPC_READER_LIMIT_INVALID');
  const allowed = new Set([
    'getGenesisHash',
    'getSlot',
    'getMinimumBalanceForRentExemption',
    'getMultipleAccounts',
    'getLatestBlockhash',
    'getFeeForMessage',
  ]);
  return (endpoint, init) => {
    let payload;
    try {
      payload = JSON.parse(String(init?.body));
    } catch {
      fail('RPC_PAYLOAD_INVALID');
    }
    const list = Array.isArray(payload) ? payload : [payload];
    if (!list.length || list.some((item) => !allowed.has(item?.method)))
      fail('RPC_WRITE_OR_UNEXPECTED_METHOD_BLOCKED');
    return boundedResponse(endpoint, init);
  };
  async function boundedResponse(endpoint, init) {
    const controller = new AbortController(),
      signal = init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let rejectAbort,
      reader,
      complete = false;
    const aborted = new Promise((_, reject) => {
      rejectAbort = () => reject(new BootstrapError('RPC_RESPONSE_TIMEOUT_OR_ABORTED'));
    });
    signal.addEventListener('abort', rejectAbort, { once: true });
    try {
      if (signal.aborted) fail('RPC_RESPONSE_TIMEOUT_OR_ABORTED');
      const response = await Promise.race([
        transport(endpoint, { ...init, redirect: 'error', signal }),
        aborted,
      ]);
      if (response.redirected || (response.status >= 300 && response.status < 400))
        fail('RPC_REDIRECT_DENIED');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))))
        fail('RPC_RESPONSE_LENGTH_INVALID');
      if (length !== null && Number(length) > maximumBytes) fail('RPC_RESPONSE_TOO_LARGE');
      const chunks = [];
      let size = 0;
      if (response.body) {
        reader = response.body.getReader();
        while (true) {
          const part = await Promise.race([reader.read(), aborted]);
          if (part.done) break;
          if (!(part.value instanceof Uint8Array)) fail('RPC_RESPONSE_BODY_INVALID');
          size += part.value.byteLength;
          if (size > maximumBytes) fail('RPC_RESPONSE_TOO_LARGE');
          chunks.push(Buffer.from(part.value));
        }
      }
      const result = new Response(response.body === null ? null : Buffer.concat(chunks, size), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      complete = true;
      return result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', rejectAbort);
      if (!complete) {
        controller.abort();
        if (reader) void reader.cancel().catch(() => {});
      }
      try {
        reader?.releaseLock();
      } catch {
        /* A canceled/stalled reader may still have a pending read. */
      }
    }
  }
}
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function readBoundedFile(filename, maximumBytes, { io = fs } = {}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 10 * 1024 * 1024)
    fail('INPUT_FILE_LIMIT_INVALID');
  let descriptor;
  try {
    const location = path.resolve(filename),
      before = io.lstatSync(location, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) fail('INPUT_FILE_NOT_REGULAR');
    if (before.size > BigInt(maximumBytes)) fail('INPUT_FILE_TOO_LARGE');
    const flags =
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    descriptor = io.openSync(location, flags);
    const opened = io.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      fail('INPUT_FILE_CHANGED_DURING_OPEN');
    if (opened.size > BigInt(maximumBytes)) fail('INPUT_FILE_TOO_LARGE');
    const buffer = Buffer.alloc(Math.min(maximumBytes + 1, 65536)),
      chunks = [];
    let size = 0;
    while (size <= maximumBytes) {
      const count = io.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, maximumBytes + 1 - size),
        null
      );
      if (
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count > Math.min(buffer.length, maximumBytes + 1 - size)
      )
        fail('INPUT_FILE_READ_FAILED');
      if (count === 0) break;
      size += count;
      if (size > maximumBytes) fail('INPUT_FILE_TOO_LARGE');
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    const after = io.fstatSync(descriptor, { bigint: true });
    if (
      !after.isFile() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      BigInt(size) !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs
    )
      fail('INPUT_FILE_CHANGED_DURING_READ');
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    fail('INPUT_FILE_READ_FAILED');
  } finally {
    if (descriptor !== undefined) {
      try {
        io.closeSync(descriptor);
      } catch {
        fail('INPUT_FILE_CLOSE_FAILED');
      }
    }
  }
}
function publicKey(value) {
  try {
    if (
      typeof value !== 'string' ||
      value.length < 32 ||
      value.length > 44 ||
      new PublicKey(value).toBase58() !== value
    )
      fail('PUBLIC_ADDRESS_INVALID');
    return new PublicKey(value);
  } catch {
    fail('PUBLIC_ADDRESS_INVALID');
  }
}
function exactKeys(value, allowed, code) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    fail(code);
}
function authorities(input) {
  exactKeys(
    input,
    [
      'version',
      'recordedOn',
      'networkGenesis',
      'controller',
      'company',
      'legacyCompanyWallets',
      'vault',
      'upgradeAuthority',
      'status',
      'custodyVerified',
      'productionSignerConfigured',
    ],
    'OWNER_AUTHORITIES_INVALID'
  );
  if (
    input.version !== 1 ||
    input.networkGenesis !== MAINNET ||
    input.controller !== 'project-owner' ||
    input.status !== 'owner-provided-intended-authorities'
  )
    fail('OWNER_AUTHORITIES_INVALID');
  exactKeys(input.vault, ['governor', 'operator', 'treasury'], 'OWNER_ROLES_INVALID');
  for (const role of ['governor', 'operator', 'treasury']) {
    const key = publicKey(input.vault[role]);
    if (key.equals(PublicKey.default) || !PublicKey.isOnCurve(key.toBytes()))
      fail('OWNER_ROLES_INVALID');
  }
  publicKey(input.upgradeAuthority);
  if (input.upgradeAuthority !== input.vault.governor)
    fail('INITIAL_GOVERNOR_MUST_BE_UPGRADE_AUTHORITY');
  return {
    governor: input.vault.governor,
    operator: input.vault.operator,
    treasury: input.vault.treasury,
    upgradeAuthority: input.upgradeAuthority,
  };
}
function reviewed(input, owner) {
  if (!input) fail('INDEPENDENT_PROGRAM_AND_CONFIG_PINS_REQUIRED');
  exactKeys(input, ['version', 'networkGenesis', 'program', 'config'], 'REVIEWED_INPUT_INVALID');
  exactKeys(
    input.program,
    ['address', 'upgradeAuthority', 'elfSha256', 'deployedDataSha256'],
    'REVIEWED_PROGRAM_INVALID'
  );
  exactKeys(input.config, ['address', 'digest'], 'REVIEWED_CONFIG_INVALID');
  if (input.version !== 1 || input.networkGenesis !== MAINNET) fail('REVIEWED_NETWORK_INVALID');
  const program = publicKey(input.program.address),
    config = publicKey(input.config.address);
  if (
    input.program.upgradeAuthority !== owner.upgradeAuthority ||
    !hash(input.program.elfSha256) ||
    !hash(input.program.deployedDataSha256) ||
    !hash(input.config.digest)
  )
    fail('REVIEWED_PINS_INVALID');
  if (
    [
      PublicKey.default,
      sdk.DYNAMIC_BONDING_CURVE_PROGRAM_ID,
      sdk.DAMM_V2_PROGRAM_ID,
      config,
      ...Object.values(owner).map(publicKey),
    ].some((key) => program.equals(key))
  )
    fail('PROGRAM_ID_COLLIDES_WITH_ROLES');
  return { program, config };
}
function verifyElf(elf, pin) {
  if (
    !Buffer.isBuffer(elf) ||
    elf.length < 64 ||
    elf.length > 10 * 1024 * 1024 ||
    elf.subarray(0, 4).toString('hex') !== '7f454c46' ||
    !hash(pin) ||
    sha(elf) !== pin
  )
    fail('REVIEWED_ELF_HASH_INVALID');
}
function loadAbi(name) {
  const filename = path.resolve(__dirname, `../scaffolds/fun-launch/src/lib/vault/${name}.ts`),
    ts = app('typescript');
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(result.outputText, filename);
  return loaded.exports;
}
const abi = loadAbi('client'),
  state = loadAbi('state');
async function mainnet(rpc) {
  if ((await rpc.getGenesisHash()) !== MAINNET) fail('RPC_IS_NOT_MAINNET');
}
const safeNumber = (value, code) => {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
};
const base = () => ({
  version: 1,
  networkGenesis: MAINNET,
  readOnlyRpc: true,
  unsignedOnly: true,
  finalPaused: true,
  financialReleaseReady: false,
  mainnetGateOpened: false,
  sideEffects: {
    signaturesCreated: 0,
    transactionsBroadcast: 0,
    keysGenerated: 0,
    privateKeyFilesRead: 0,
  },
});
const sources = {
  agaveLock: 'https://github.com/anza-xyz/agave/blob/v2.3.13/Cargo.lock',
  loader:
    'https://github.com/anza-xyz/solana-sdk/blob/loader-v3-interface%40v5.0.0/loader-v3-interface/src/state.rs',
  nativeLayout: 'programs/rinsed-vault/state-layout.json',
};
async function estimateBootstrap({ rpc, owner: input, elf, elfSha256, maxDataLength }) {
  const owner = authorities(input);
  verifyElf(elf, elfSha256);
  const length =
    maxDataLength === undefined ? elf.length : safeNumber(maxDataLength, 'MAX_DATA_LENGTH_INVALID');
  if (length < elf.length || length > 10 * 1024 * 1024 - 45) fail('MAX_DATA_LENGTH_INVALID');
  await mainnet(rpc);
  const slot = safeNumber(await rpc.getSlot('finalized'), 'FINALIZED_SLOT_INVALID');
  const sizes = {
    program: 36,
    programData: 45 + length,
    temporaryBuffer: 37 + elf.length,
    settings: layout.settings.size,
    configApproval: layout.configApproval.size,
  };
  const entries = await Promise.all(
    Object.entries(sizes).map(async ([account, bytes]) => ({
      account,
      bytes,
      rentLamports: String(await positiveRent(rpc, bytes)),
      temporary: account === 'temporaryBuffer',
    }))
  );
  await mainnet(rpc);
  return {
    ...base(),
    mode: 'estimate',
    observedFinalizedSlot: slot,
    owner,
    reviewedElfSha256: elfSha256,
    elfBytes: elf.length,
    maxDataLength: length,
    layoutSources: sources,
    rentAccounts: entries,
    permanentRentLamports: entries
      .filter((e) => !e.temporary)
      .reduce((sum, e) => sum + BigInt(e.rentLamports), 0n)
      .toString(),
    temporaryBufferRentLamports: entries.find((e) => e.temporary).rentLamports,
    rentOnly: true,
    transactionFees: null,
    note: 'RPC rent thresholds for a fresh deployment and native settings/config approval only. Temporary buffer rent can be recovered/reused by the loader. Deployment transaction count, priority fees, DBC config creation, and existing account balances are not included. Intended public roles are not proof of signer custody.',
  };
}
async function positiveRent(rpc, bytes) {
  const value = safeNumber(
    await rpc.getMinimumBalanceForRentExemption(bytes, 'finalized'),
    'RENT_RESPONSE_INVALID'
  );
  // web3.js returns zero for an RPC error; do not turn that fallback into a cost estimate.
  if (value === 0) fail('RENT_RESPONSE_INVALID');
  return value;
}
function vacant(account) {
  return (
    !account ||
    (!account.executable &&
      account.owner.equals(SystemProgram.programId) &&
      account.data.length === 0)
  );
}
function approvalMatches(account, program, config, digest) {
  if (
    !account ||
    !account.owner.equals(program) ||
    account.executable ||
    account.data.length !== layout.configApproval.size ||
    account.data.subarray(0, 8).toString('ascii') !== layout.configApproval.magic ||
    account.data[8] !== 1 ||
    account.data[9] !==
      PublicKey.findProgramAddressSync([Buffer.from('config'), config.toBuffer()], program)[1] ||
    !new PublicKey(account.data.subarray(10, 42)).equals(config) ||
    account.data.subarray(42, 74).toString('hex') !== digest
  )
    fail('EXISTING_APPROVAL_MISMATCH');
}
async function prepareBootstrap({ rpc, owner: input, review, elf }) {
  const owner = authorities(input),
    { program, config } = reviewed(review, owner);
  verifyElf(elf, review.program.elfSha256);
  const governor = publicKey(owner.governor),
    operator = publicKey(owner.operator),
    treasury = publicKey(owner.treasury),
    pd = programDataAddress(program),
    addresses = abi.vaultAddresses(program, config),
    approval = abi.configApprovalAddress(program, config);
  if (
    [governor, operator, treasury].some(
      (key) =>
        key.equals(addresses.feeAuthority) ||
        key.equals(addresses.settings) ||
        key.equals(approval) ||
        key.equals(config)
    )
  )
    fail('ROLE_COLLIDES_WITH_PROTOCOL_ACCOUNT');
  await mainnet(rpc);
  const snapshot = await rpc.getMultipleAccountsInfoAndContext(
    [program, pd, config, addresses.settings, approval],
    { commitment: 'finalized' }
  );
  const slot = safeNumber(snapshot.context?.slot, 'FINALIZED_SLOT_INVALID');
  if (!Array.isArray(snapshot.value) || snapshot.value.length !== 5)
    fail('ACCOUNT_SNAPSHOT_INCOMPLETE');
  const [programAccount, dataAccount, configAccount, settingsAccount, approvalAccount] =
    snapshot.value;
  if (!programAccount?.owner.equals(UPGRADEABLE)) fail('CANONICAL_UPGRADEABLE_LOADER_REQUIRED');
  const observed = inspectProgram(program, programAccount, dataAccount, review.program);
  if (!observed.ok)
    fail(
      observed.authorityMatches
        ? 'DEPLOYED_PROGRAM_HASH_MISMATCH'
        : 'PROGRAM_UPGRADE_AUTHORITY_MISMATCH'
    );
  if (BigInt(observed.deployedAtSlot) > BigInt(slot)) fail('PROGRAM_DEPLOYMENT_AFTER_SNAPSHOT');
  const deployed = dataAccount.data.subarray(45);
  if (
    deployed.length < elf.length ||
    !deployed.subarray(0, elf.length).equals(elf) ||
    deployed.subarray(elf.length).some((byte) => byte !== 0)
  )
    fail('DEPLOYED_ELF_DIFFERS_FROM_REVIEWED_SOURCE');
  if (
    !configAccount?.owner.equals(sdk.DYNAMIC_BONDING_CURVE_PROGRAM_ID) ||
    configAccount.executable ||
    sha(configAccount.data) !== review.config.digest
  )
    fail('DBC_CONFIG_OWNER_OR_DIGEST_MISMATCH');
  const issues = inspectLaunchConfig(decodeConfig(configAccount.data), {
    feeClaimer: addresses.feeAuthority.toBase58(),
    leftoverReceiver: owner.treasury,
  });
  if (issues.length) fail('DBC_CONFIG_POLICY_OR_AUTHORITY_MISMATCH');
  const instructions = [];
  let alreadyInitialized = false,
    alreadyApproved = false;
  if (vacant(settingsAccount))
    instructions.push(
      abi.initializeVaultInstruction({
        programId: program,
        governor,
        operator,
        treasury,
        paused: false,
      })
    );
  else {
    if (
      !settingsAccount.owner.equals(program) ||
      settingsAccount.executable ||
      settingsAccount.data.length !== layout.settings.size
    )
      fail('EXISTING_SETTINGS_OWNER_OR_LAYOUT_MISMATCH');
    const settings = state.decodeVaultSettings(settingsAccount.data);
    if (
      settingsAccount.data[9] !==
      PublicKey.findProgramAddressSync([Buffer.from('settings')], program)[1]
    )
      fail('EXISTING_SETTINGS_BUMP_MISMATCH');
    if (
      !settings.governor.equals(governor) ||
      !settings.operator.equals(operator) ||
      !settings.treasury.equals(treasury)
    )
      fail('EXISTING_SETTINGS_ROLES_MISMATCH');
    if (!settings.paused) fail('EXISTING_SETTINGS_MUST_BE_PAUSED');
    alreadyInitialized = true;
  }
  if (!vacant(approvalAccount)) {
    approvalMatches(approvalAccount, program, config, review.config.digest);
    alreadyApproved = true;
    if (!alreadyInitialized) fail('APPROVAL_WITHOUT_SETTINGS');
  }
  if (!alreadyApproved) {
    if (alreadyInitialized) instructions.push(abi.setPausedInstruction(program, governor, false));
    instructions.push(abi.approveConfigInstruction(program, governor, config));
    instructions.push(abi.setPausedInstruction(program, governor, true));
  }
  if (!instructions.length) {
    await mainnet(rpc);
    return {
      ...base(),
      mode: 'prepare',
      status: 'already-prepared-on-chain',
      observedFinalizedSlot: slot,
      program: program.toBase58(),
      config: config.toBase58(),
      owner,
      transactions: [],
    };
  }
  const prepared = await rpc.getLatestBlockhashAndContext({
    commitment: 'finalized',
    minContextSlot: slot,
  });
  if (safeNumber(prepared.context?.slot, 'PREPARATION_SLOT_INVALID') < slot)
    fail('PREPARATION_SLOT_TOO_OLD');
  publicKey(prepared.value?.blockhash);
  safeNumber(prepared.value?.lastValidBlockHeight, 'LAST_VALID_HEIGHT_INVALID');
  const transaction = new Transaction({
      feePayer: governor,
      recentBlockhash: prepared.value.blockhash,
    }).add(...instructions),
    message = transaction.serializeMessage();
  if (
    transaction.signatures.some((entry) => entry.signature !== null) ||
    transaction.compileMessage().header.numRequiredSignatures !== 1
  )
    fail('UNEXPECTED_SIGNATURE_OR_SIGNER');
  const last = transaction.instructions.at(-1),
    expectedLast = abi.setPausedInstruction(program, governor, true);
  if (
    !last.programId.equals(program) ||
    !last.data.equals(expectedLast.data) ||
    JSON.stringify(last.keys) !== JSON.stringify(expectedLast.keys)
  )
    fail('FINAL_PAUSE_INSTRUCTION_MISSING');
  const wire = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
  if (wire.length > 1232) fail('UNSIGNED_TRANSACTION_TOO_LARGE');
  const fee = await rpc.getFeeForMessage(transaction.compileMessage(), 'finalized');
  if (safeNumber(fee.context?.slot, 'FEE_SNAPSHOT_INVALID') < prepared.context.slot)
    fail('FEE_SNAPSHOT_TOO_OLD');
  if (fee.value === null) fail('PREPARATION_BLOCKHASH_FEE_UNAVAILABLE');
  safeNumber(fee.value, 'FEE_RESPONSE_INVALID');
  await mainnet(rpc);
  return {
    ...base(),
    mode: 'prepare',
    status: 'unsigned-prepared',
    observedFinalizedSlot: slot,
    program: program.toBase58(),
    programData: pd.toBase58(),
    settings: addresses.settings.toBase58(),
    feeAuthority: addresses.feeAuthority.toBase58(),
    config: config.toBase58(),
    approval: approval.toBase58(),
    owner,
    reviewedProgramElfSha256: review.program.elfSha256,
    reviewedDeployedDataSha256: review.program.deployedDataSha256,
    reviewedConfigDigest: review.config.digest,
    accountSnapshotDigests: {
      program: sha(programAccount.data),
      programData: sha(dataAccount.data),
      config: sha(configAccount.data),
      settings: settingsAccount ? sha(settingsAccount.data) : null,
      approval: approvalAccount ? sha(approvalAccount.data) : null,
    },
    transactions: [
      {
        transactionBase64: wire.toString('base64'),
        messageDigest: sha(message),
        requiredSigners: [owner.governor],
        preparedSlot: prepared.context.slot,
        blockhash: prepared.value.blockhash,
        lastValidBlockHeight: prepared.value.lastValidBlockHeight,
        estimatedTransactionFeeLamports: fee.value === null ? null : String(fee.value),
        instructionNames: alreadyInitialized
          ? ['set_paused_false', 'approve_config', 'set_paused_true']
          : ['initialize_unpaused', 'approve_config', 'set_paused_true'],
      },
    ],
    recovery:
      'This unsigned artifact has no transaction ID and is not evidence of submission. Before external signing recheck genesis, reviewed code/authorities/config and current settings. An expired blockhash requires preparing a fresh unsigned artifact; never treat expiry as a failed or successful transaction. Initialization/unpause, approval and final pause remain atomic in this one message.',
    custodyVerified: false,
  };
}
module.exports = {
  authorities,
  reviewed,
  verifyElf,
  estimateBootstrap,
  prepareBootstrap,
  sha,
  MAINNET,
  loadAbi,
  BootstrapError,
  redactBootstrapError,
  readOnlyRpcFetch,
  readBoundedFile,
};
