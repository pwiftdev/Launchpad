/* Real protocol rehearsal. Funded role secrets remain inside the isolated VM. */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const appRequire = Module.createRequire(
  path.resolve(__dirname, '../scaffolds/fun-launch/package.json')
);
const { PublicKey, Keypair, Transaction, ComputeBudgetProgram } = appRequire('@solana/web3.js');
const { NATIVE_MINT, getAssociatedTokenAddressSync } = appRequire('@solana/spl-token');
const sdk = appRequire('@meteora-ag/dynamic-bonding-curve-sdk');
const { CpAmm } = appRequire('@meteora-ag/cp-amm-sdk');
const BN = appRequire('bn.js');
const { NETWORK_GENESIS, localValidatorPolicy } = require('./network-policy.cjs');
const { inspectLaunchConfig } = require('./launch-policy.cjs');

// Compile only the checked-in standalone ABI modules, keeping one source of truth.
function loadAbi(name) {
  const filename = path.resolve(__dirname, `../scaffolds/fun-launch/src/lib/vault/${name}.ts`);
  const ts = appRequire('typescript');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
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
  loaded._compile(compiled.outputText, filename);
  return loaded.exports;
}
const abi = loadAbi('client'),
  stateAbi = loadAbi('state');

function assertPinned(sender, env = process.env) {
  if (
    !localValidatorPolicy(env) ||
    env.RPC_URL !== 'http://127.0.0.1:8899' ||
    sender.fixture.rpcUrl !== env.RPC_URL ||
    sender.fixture.networkGenesis !== env.LOCAL_VALIDATOR_GENESIS_HASH ||
    Object.values(NETWORK_GENESIS).includes(sender.fixture.networkGenesis)
  )
    throw new Error(
      'Real protocol rehearsal requires an independently pinned isolated loopback validator'
    );
}
function curveTemplate() {
  const ts = appRequire('typescript');
  const parsed = ts.parseConfigFileTextToJson(
    'dbc_config.jsonc',
    fs.readFileSync(path.resolve(__dirname, '../studio/config/dbc_config.jsonc'), 'utf8')
  );
  if (parsed.error || parsed.config.dryRun !== true) throw new Error('Unsafe DBC template');
  const { buildCurveMode, feeClaimer, leftoverReceiver, ...params } = parsed.config.dbcConfig;
  if (buildCurveMode !== 0) throw new Error('Unexpected curve builder');
  return sdk.buildCurve(params);
}
function assertPacket(transaction, payer) {
  transaction.feePayer ??= payer;
  const blockhash = transaction.recentBlockhash;
  transaction.recentBlockhash ??= PublicKey.default.toBase58();
  const message = transaction.compileMessage();
  const size = 1 + message.header.numRequiredSignatures * 64 + message.serialize().length;
  transaction.recentBlockhash = blockhash;
  if (size > 1232) throw new Error(`Rehearsal transaction exceeds packet limit (${size})`);
  return size;
}
function rehearsalArguments(args) {
  const phases = [
    '--prepare',
    '--post',
    '--graduate',
    '--graduate-unbound',
    '--bind',
    '--damm-roundtrip',
  ];
  const phase = args.find((value) => phases.includes(value));
  const fileAt = args.indexOf('--state-file');
  const fixtureAt = args.indexOf('--fixture-file');
  const expectedLength = 1 + (fileAt < 0 ? 0 : 2) + (fixtureAt < 0 ? 0 : 2);
  if (
    !phase ||
    args.filter((value) => phases.includes(value)).length !== 1 ||
    args.length !== expectedLength ||
    args.filter((value) => value === '--state-file').length > 1 ||
    args.filter((value) => value === '--fixture-file').length > 1 ||
    (fileAt >= 0 && (fileAt === args.length - 1 || args[fileAt + 1].startsWith('--'))) ||
    (fixtureAt >= 0 && (fixtureAt === args.length - 1 || args[fixtureAt + 1].startsWith('--')))
  )
    throw new Error(
      'Use one rehearsal phase with optional guarded --state-file and --fixture-file .local paths'
    );
  const localRoot = path.resolve(__dirname, '../.local');
  const statePath =
    fileAt < 0
      ? path.join(localRoot, 'meteora-rehearsal-state.json')
      : path.resolve(args[fileAt + 1]);
  if (
    path.dirname(statePath) !== localRoot ||
    !/^(?:meteora-rehearsal-state(?:[-_A-Za-z0-9]{0,80})|meteora-mainnet-binary-state)\.json$/.test(
      path.basename(statePath)
    )
  )
    throw new Error(
      'Rehearsal state must be a dedicated meteora-rehearsal-state*.json file directly inside .local'
    );
  const fixturePath =
    fixtureAt < 0
      ? path.join(localRoot, 'mainnet-rehearsal-fixture.json')
      : path.resolve(args[fixtureAt + 1]);
  if (
    path.dirname(fixturePath) !== localRoot ||
    !['mainnet-rehearsal-fixture.json', 'mainnet-binary-fixture.json'].includes(
      path.basename(fixturePath)
    )
  )
    throw new Error('Rehearsal fixture must be a dedicated pinned .local profile fixture');
  return { phase: phase.slice(2), statePath, fixturePath };
}
async function createRehearsal(
  sender,
  { statePath = path.resolve('.local/meteora-rehearsal-state.json'), env = process.env } = {}
) {
  assertPinned(sender, env);
  const { connection, programId, roles } = sender;
  const client = new sdk.DynamicBondingCurveClient(connection, 'confirmed');
  let state = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''))
    : {
        networkGenesis: sender.fixture.networkGenesis,
        programId: programId.toBase58(),
        coins: [],
        transactions: [],
      };
  if (!fs.existsSync(statePath) && sender.fixture.profile !== 'mainnet-binaries') {
    const originalPath = path.resolve('.local/meteora-rehearsal-state.json');
    if (path.resolve(statePath) !== originalPath && fs.existsSync(originalPath)) {
      const original = JSON.parse(fs.readFileSync(originalPath, 'utf8').replace(/^\uFEFF/, ''));
      if (
        original.networkGenesis !== state.networkGenesis ||
        original.programId !== state.programId
      )
        throw new Error('Existing config seed belongs to a different validator/program');
      for (const key of ['config', 'configSignature', 'configSlot', 'configDigest'])
        if (original[key] !== undefined) state[key] = original[key];
    }
  }
  if (
    state.networkGenesis !== sender.fixture.networkGenesis ||
    state.programId !== programId.toBase58()
  )
    throw new Error('Rehearsal state belongs to a different validator/program');
  if (!Array.isArray(state.coins) || !Array.isArray(state.transactions))
    throw new Error('Invalid dedicated rehearsal state shape');
  if (state.profile && state.profile !== sender.fixture.profile)
    throw new Error('Rehearsal state belongs to a different protocol binary profile');
  state.profile = sender.fixture.profile ?? 'devnet-binaries';
  const save = () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2));
    fs.renameSync(`${statePath}.tmp`, statePath);
  };
  async function send(label, tx, role, signers = []) {
    assertPinned(sender, env);
    if ((await connection.getGenesisHash()) !== state.networkGenesis)
      throw new Error('Validator changed');
    const bytes = assertPacket(tx, roles[role]);
    const result = await sender.send(tx, { roles: [role], signers });
    state.transactions.push({ label, signature: result.signature, slot: result.slot, bytes });
    save();
    console.log(JSON.stringify({ label, ...result, bytes }));
    return result;
  }
  async function time() {
    const slot = await connection.getSlot('confirmed'),
      now = await connection.getBlockTime(slot);
    if (now === null) throw new Error('Validator clock unavailable');
    return now;
  }
  const poolFor = (coin) => new PublicKey(coin.pool);
  async function creationFor(address) {
    const history = await connection.getSignaturesForAddress(address, { limit: 100 }, 'confirmed');
    const oldest = history.filter((item) => !item.err).at(-1);
    if (!oldest || history.length === 100)
      throw new Error('Cannot prove pending fixture creation boundary');
    return { signature: oldest.signature, slot: oldest.slot };
  }
  async function dbcSwap(coin, side, amountIn, partial = false) {
    const virtualPool = await client.state.getPool(poolFor(coin));
    const config = await client.state.getPoolConfig(state.config);
    if (!virtualPool || !config) throw new Error('Missing reviewed pool');
    const swapMode = partial ? sdk.SwapMode.PartialFill : sdk.SwapMode.ExactIn;
    const quote = client.pool.swapQuote2({
      virtualPool,
      config,
      swapBaseForQuote: side === 'sell',
      amountIn,
      swapMode,
      slippageBps: 200,
      hasReferral: false,
      eligibleForFirstSwapWithMinFee: false,
      currentPoint: new BN(await time()),
    });
    const tx = await client.pool.swap2({
      owner: roles.trader,
      pool: poolFor(coin),
      amountIn,
      minimumAmountOut: quote.minimumAmountOut,
      swapMode,
      swapBaseForQuote: side === 'sell',
      referralTokenAccount: null,
    });
    const result = await send(
      `${coin.mode}-dbc-${side}${partial ? '-threshold' : ''}`,
      tx,
      'trader'
    );
    coin.trades ??= [];
    coin.trades.push(result.signature);
    save();
    return result;
  }
  async function prepare() {
    const settingsAddress = abi.vaultAddresses(programId, NATIVE_MINT).settings;
    const settingsAccount = await connection.getAccountInfo(settingsAddress, 'confirmed');
    if (!settingsAccount)
      await send(
        'initialize-vault',
        new Transaction().add(
          abi.initializeVaultInstruction({
            programId,
            governor: roles.governor,
            operator: roles.operator,
            treasury: roles.treasury,
            paused: false,
          })
        ),
        'governor'
      );
    else {
      if (!settingsAccount.owner.equals(programId)) throw new Error('Wrong native settings owner');
      const settings = stateAbi.decodeVaultSettings(settingsAccount.data);
      if (
        !settings.governor.equals(roles.governor) ||
        !settings.operator.equals(roles.operator) ||
        !settings.treasury.equals(roles.treasury)
      )
        throw new Error('Existing native roles differ from the isolated fixture');
      if (settings.paused)
        await send(
          'unpause-isolated-vault',
          new Transaction().add(abi.setPausedInstruction(programId, roles.governor, false)),
          'governor'
        );
    }
    const feeClaimer = abi.vaultAddresses(programId, NATIVE_MINT).feeAuthority;
    if (!state.config && state.pendingConfig) {
      const pending = new PublicKey(state.pendingConfig);
      if (await connection.getAccountInfo(pending)) {
        const created = await creationFor(pending);
        state.config = state.pendingConfig;
        state.configSignature = created.signature;
        state.configSlot = created.slot;
        delete state.pendingConfig;
        save();
      }
    }
    if (!state.config) {
      const configKeypair = Keypair.generate();
      state.pendingConfig = configKeypair.publicKey.toBase58();
      save();
      const tx = await client.partner.createConfig({
        config: configKeypair.publicKey,
        quoteMint: NATIVE_MINT,
        feeClaimer,
        leftoverReceiver: roles.treasury,
        payer: roles.governor,
        ...curveTemplate(),
      });
      const result = await send('create-reviewed-config', tx, 'governor', [configKeypair]);
      state.config = configKeypair.publicKey.toBase58();
      state.configSignature = result.signature;
      state.configSlot = result.slot;
      delete state.pendingConfig;
      save();
    }
    const configKey = new PublicKey(state.config),
      config = await client.state.getPoolConfig(configKey);
    if (!config) throw new Error('Config creation is pending');
    const issues = inspectLaunchConfig(config, { feeClaimer, leftoverReceiver: roles.treasury });
    if (issues.length) throw new Error(`Actual config policy failed: ${JSON.stringify(issues)}`);
    const configAccount = await connection.getAccountInfo(configKey, 'confirmed');
    if (!configAccount?.owner.equals(sdk.DYNAMIC_BONDING_CURVE_PROGRAM_ID))
      throw new Error('Wrong actual config owner');
    state.configDigest = crypto.createHash('sha256').update(configAccount.data).digest('hex');
    if (!(await connection.getAccountInfo(abi.configApprovalAddress(programId, configKey))))
      await send(
        'approve-native-config',
        new Transaction().add(abi.approveConfigInstruction(programId, roles.governor, configKey)),
        'governor'
      );
    save();
    if (state.pendingLaunch) {
      const pending = state.pendingLaunch,
        mint = new PublicKey(pending.mint);
      const native = await connection.getAccountInfo(abi.vaultAddresses(programId, mint).coin);
      if (native) {
        if (!native.owner.equals(programId)) throw new Error('Wrong pending native identity owner');
        const identity = stateAbi.decodeVaultCoin(native.data),
          created = await creationFor(new PublicKey(pending.pool));
        if (
          identity.mode !== pending.mode ||
          identity.mint.toBase58() !== pending.mint ||
          identity.pool.toBase58() !== pending.pool ||
          identity.creator.toBase58() !== pending.deployer ||
          identity.config.toBase58() !== state.config
        )
          throw new Error('Pending launch immutable identity mismatch');
        if (!state.coins.some((coin) => coin.mint === pending.mint))
          state.coins.push({
            ...pending,
            activationPoint: identity.activationTime.toString(),
            creationSignature: created.signature,
            creationSlot: created.slot,
            trades: [],
            rinseProofPending: true,
          });
      } else if (await connection.getAccountInfo(new PublicKey(pending.pool)))
        throw new Error('Pending DBC launch exists without atomic native registration');
      delete state.pendingLaunch;
      save();
    }
    for (const mode of ['creator', 'community']) {
      if (state.coins.some((coin) => coin.mode === mode)) continue;
      const role = mode === 'creator' ? 'creator' : 'community',
        creator = roles[role];
      const mintKeypair = Keypair.generate(),
        mint = mintKeypair.publicKey;
      const pool = sdk.deriveDbcPoolAddress(NATIVE_MINT, mint, configKey);
      const firstBuy = client.pool.getQuoteFromOutputAmount({
        config,
        swapBaseForQuote: false,
        amountOut: new BN('20000000000000'),
        eligibleForFirstSwapWithMinFee: true,
        hasReferral: false,
      });
      const preparedSlot = await connection.getSlot('finalized');
      state.pendingLaunch = {
        mode,
        mint: mint.toBase58(),
        pool: pool.toBase58(),
        deployer: creator.toBase58(),
        preparedSlot,
      };
      save();
      const tx = await client.creator.createPoolWithFirstBuy({
        createPoolParam: {
          config: configKey,
          baseMint: mint,
          name: `Rinsed ${mode} rehearsal`,
          symbol: mode === 'creator' ? 'RCR' : 'RCM',
          uri: 'ipfs://local-rehearsal',
          payer: creator,
          poolCreator: creator,
        },
        firstBuyParam: {
          buyer: creator,
          buyAmount: firstBuy.includedFeeInputAmount,
          minimumAmountOut: new BN('19800000000000'),
          referralTokenAccount: null,
        },
      });
      tx.add(
        abi.registerCoinInstruction({ programId, mint, pool, config: configKey, creator, mode }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 450_000 })
      );
      const created = await send(`${mode}-atomic-launch-first-buy`, tx, role, [mintKeypair]);
      const account = await connection.getAccountInfo(
        abi.vaultAddresses(programId, mint).coin,
        'confirmed'
      );
      if (!account?.owner.equals(programId)) throw new Error('Native launch registration missing');
      const identity = stateAbi.decodeVaultCoin(account.data);
      if (
        identity.mode !== mode ||
        !identity.creator.equals(creator) ||
        !identity.pool.equals(pool) ||
        !identity.mint.equals(mint)
      )
        throw new Error('Native immutable identity differs from launch');
      const coin = {
        mode,
        mint: mint.toBase58(),
        pool: pool.toBase58(),
        deployer: creator.toBase58(),
        activationPoint: identity.activationTime.toString(),
        creationSignature: created.signature,
        creationSlot: created.slot,
        preparedSlot,
        trades: [],
      };
      state.coins.push(coin);
      delete state.pendingLaunch;
      save();
      // Execute immediately, before running the next mode's preparation, to exercise real high-tax swaps.
      await dbcSwap(coin, 'buy', new BN(1_000_000_000));
      coin.rinseObservedTime = await time();
      save();
      if (coin.rinseObservedTime >= Number(coin.activationPoint) + 27)
        throw new Error(
          'Local execution was too slow to prove a RINSE trade; do not mark this scenario passed'
        );
    }
    if (state.coins.some((coin) => coin.rinseProofPending))
      throw new Error(
        'Recovered an already-launched fixture after interrupted confirmation. Its high-tax scenario still needs actual event evidence; no replacement token was created.'
      );
    return state;
  }
  async function post() {
    if (state.coins.length !== 2) throw new Error('Prepare both modes first');
    for (const coin of state.coins) {
      if ((await time()) < Number(coin.activationPoint) + 27)
        throw new Error('Wait until the actual chain reaches the scheduled fee floor');
      await dbcSwap(coin, 'buy', new BN(200_000_000));
      const balance = await connection.getTokenAccountBalance(
        getAssociatedTokenAddressSync(new PublicKey(coin.mint), roles.trader)
      );
      const amount = new BN(balance.value.amount).divn(10);
      if (amount.gtn(0)) await dbcSwap(coin, 'sell', amount);
    }
    return state;
  }
  async function graduate(bindNative = true) {
    for (const coin of state.coins) {
      const mint = new PublicKey(coin.mint),
        config = await client.state.getPoolConfig(state.config);
      let pool = await client.state.getPool(poolFor(coin));
      if (!pool || !config) throw new Error('Missing original launch');
      if ((await time()) < Number(coin.activationPoint) + 27)
        throw new Error('Run the normal post-RINSE scenario before graduation');
      if (Number(pool.poolState.isMigrated) !== 1) {
        if (pool.poolState.quoteReserve.lt(config.migrationQuoteThreshold))
          await dbcSwap(coin, 'buy', new BN(100_000_000_000), true);
        pool = await client.state.getPool(poolFor(coin));
        if (pool.poolState.quoteReserve.lt(config.migrationQuoteThreshold))
          throw new Error('Partial-fill swap did not reach graduation');
        const migrated = await client.migration.migrateToDammV2({
          pool: poolFor(coin),
          payer: roles.operator,
          dammConfig: sdk.DAMM_V2_MIGRATION_FEE_ADDRESS[6],
        });
        const result = await send(`${coin.mode}-graduate-damm`, migrated.transaction, 'operator', [
          migrated.firstPositionNftKeypair,
          migrated.secondPositionNftKeypair,
        ]);
        coin.migrationSignature = result.signature;
        coin.migrationSlot = result.slot;
        coin.migrationPositionMints = [
          migrated.firstPositionNftKeypair.publicKey.toBase58(),
          migrated.secondPositionNftKeypair.publicKey.toBase58(),
        ];
      }
      const dammPool = sdk.deriveDammV2PoolAddress(
          sdk.DAMM_V2_MIGRATION_FEE_ADDRESS[6],
          mint,
          NATIVE_MINT
        ),
        damm = new CpAmm(connection);
      const migratedState = await damm._program.account.pool.fetch(dammPool);
      if (
        !migratedState.tokenAMint.equals(mint) ||
        !migratedState.tokenBMint.equals(NATIVE_MINT) ||
        migratedState.collectFeeMode !== 1
      )
        throw new Error('Actual graduation route differs from reviewed quote pair');
      coin.migratedPool = dammPool.toBase58();
      coin.migrationActivationPoint = migratedState.activationPoint.toString();
      save();
      if (bindNative) await bindCoin(coin);
      if (coin.dammTrades?.length) continue;
      const currentSlot = await connection.getSlot('confirmed');
      const quote = damm.getQuote({
        inAmount: new BN(200_000_000),
        inputTokenMint: NATIVE_MINT,
        slippage: 2,
        poolState: migratedState,
        currentTime: await time(),
        currentSlot,
        tokenADecimal: 6,
        tokenBDecimal: 9,
        hasReferral: false,
      });
      const tx = await damm.swap({
        payer: roles.trader,
        pool: dammPool,
        inputTokenMint: NATIVE_MINT,
        outputTokenMint: mint,
        amountIn: new BN(200_000_000),
        minimumAmountOut: quote.minSwapOutAmount,
        tokenAVault: migratedState.tokenAVault,
        tokenBVault: migratedState.tokenBVault,
        tokenAMint: mint,
        tokenBMint: NATIVE_MINT,
        tokenAProgram: appRequire('@solana/spl-token').TOKEN_PROGRAM_ID,
        tokenBProgram: appRequire('@solana/spl-token').TOKEN_PROGRAM_ID,
        referralTokenAccount: null,
        poolState: migratedState,
      });
      const result = await send(`${coin.mode}-damm-buy`, tx, 'trader');
      coin.dammTrades ??= [];
      coin.dammTrades.push(result.signature);
      save();
    }
    return state;
  }
  async function dammRoundtrip() {
    const { BorshCoder } = appRequire('@coral-xyz/anchor');
    const cp = appRequire('@meteora-ag/cp-amm-sdk');
    const { TOKEN_PROGRAM_ID } = appRequire('@solana/spl-token');
    const bs58 = appRequire('bs58').default ?? appRequire('bs58');
    const { compareDammExecution } = require('./local-damm-comparison.cjs');
    const coder = new BorshCoder(cp.CpAmmIdl),
      damm = new CpAmm(connection);
    const eventAuthority = PublicKey.findProgramAddressSync(
      [Buffer.from('__event_authority')],
      cp.CP_AMM_PROGRAM_ID
    )[0];
    const waitReceipt = async (signature) => {
      for (let attempt = 0; attempt < 240; attempt++) {
        const receipt = await connection.getTransaction(signature, {
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
        });
        if (receipt) return receipt;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error(
        'Saved DAMM signature not finalized; recover that signature before any new trade'
      );
    };
    for (const coin of state.coins) {
      const mint = new PublicKey(coin.mint),
        pool = sdk.deriveDammV2PoolAddress(sdk.DAMM_V2_MIGRATION_FEE_ADDRESS[6], mint, NATIVE_MINT);
      if (pool.toBase58() !== coin.migratedPool)
        throw new Error('Canonical graduated pool required');
      coin.dammComparisons ??= [];
      for (const side of ['buy', 'sell']) {
        let record = coin.dammComparisons.find((item) => item.side === side);
        if (record?.comparison) continue;
        if (!record) {
          const baseAta = getAssociatedTokenAddressSync(mint, roles.trader),
            wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, roles.trader);
          if (
            !(await connection.getAccountInfo(baseAta, 'finalized')) ||
            (await connection.getAccountInfo(wsolAta, 'finalized'))
          )
            throw new Error(
              'Quote comparison requires existing base ATA and absent trader WSOL ATA'
            );
          const poolInfo = await connection.getAccountInfoAndContext(pool, 'finalized');
          if (!poolInfo.value?.owner.equals(cp.CP_AMM_PROGRAM_ID))
            throw new Error('Wrong DAMM owner');
          const p = damm._program.coder.accounts.decode('pool', poolInfo.value.data);
          if (
            !p.tokenAMint.equals(mint) ||
            !p.tokenBMint.equals(NATIVE_MINT) ||
            p.collectFeeMode !== 1
          )
            throw new Error('Wrong DAMM pair or fee mode');
          const currentSlot = await connection.getSlot('finalized'),
            currentTime = await connection.getBlockTime(currentSlot);
          if (currentTime === null) throw new Error('Missing quote clock');
          const amount = new BN(
            side === 'buy'
              ? '200000000'
              : coin.dammComparisons.find((item) => item.side === 'buy').executed.amountOut
          ).divn(side === 'buy' ? 1 : 2);
          const input = side === 'buy' ? NATIVE_MINT : mint,
            output = side === 'buy' ? mint : NATIVE_MINT;
          const quote = damm.getQuote({
            inAmount: amount,
            inputTokenMint: input,
            slippage: 2,
            poolState: p,
            currentTime,
            currentSlot,
            tokenADecimal: 6,
            tokenBDecimal: 9,
            hasReferral: false,
          });
          const tx = await damm.swap({
            payer: roles.trader,
            pool,
            inputTokenMint: input,
            outputTokenMint: output,
            amountIn: amount,
            minimumAmountOut: quote.minSwapOutAmount,
            tokenAVault: p.tokenAVault,
            tokenBVault: p.tokenBVault,
            tokenAMint: mint,
            tokenBMint: NATIVE_MINT,
            tokenAProgram: TOKEN_PROGRAM_ID,
            tokenBProgram: TOKEN_PROGRAM_ID,
            referralTokenAccount: null,
            poolState: p,
          });
          assertPacket(tx, roles.trader);
          const prepared = {
            side,
            amountIn: quote.consumedInAmount.toString(),
            amountOut: quote.swapOutAmount.toString(),
            totalFee: quote.totalFee.toString(),
            minimumOut: quote.minSwapOutAmount.toString(),
            poolSnapshotSlot: poolInfo.context.slot,
            poolDigest: crypto.createHash('sha256').update(poolInfo.value.data).digest('hex'),
            currentSlot,
            currentTime,
          };
          const signed = await sender.sign(tx, { roles: ['trader'] });
          record = {
            side,
            prepared,
            signature: signed.signature,
            signedTransactionBase64: signed.signedTransactionBase64,
          };
          coin.dammComparisons.push(record);
          save(); // Persist exact quote + signed message BEFORE relay; reruns recover this same signature.
          const signature = await connection.sendRawTransaction(
            Buffer.from(signed.signedTransactionBase64, 'base64')
          );
          if (signature !== signed.signature) throw new Error('Relay changed the saved signature');
        }
        const receipt = await waitReceipt(record.signature);
        if (!receipt.meta || receipt.meta.err) throw new Error('Saved DAMM swap failed');
        const keys = receipt.transaction.message.getAccountKeys({
          accountKeysFromLookups: receipt.meta.loadedAddresses,
        });
        const events = [];
        for (const group of receipt.meta.innerInstructions ?? [])
          for (const ix of group.instructions) {
            if (!keys.get(ix.programIdIndex)?.equals(cp.CP_AMM_PROGRAM_ID)) continue;
            const bytes = Buffer.from(bs58.decode(ix.data));
            if (!bytes.subarray(0, 8).equals(Buffer.from('e445a52e51cb9a1d', 'hex'))) continue;
            if (!keys.get(ix.accounts[0])?.equals(eventAuthority))
              throw new Error('Wrong DAMM event authority');
            const event = coder.events.decode(bytes.subarray(8).toString('base64'));
            if (event?.name === 'EvtSwap2' && String(event.data.pool) === pool.toBase58())
              events.push(event.data);
          }
        if (events.length !== 1)
          throw new Error('Exactly one canonical DAMM swap witness required');
        const event = events[0],
          result = event.swap_result;
        const baseIndex = [...Array(keys.length).keys()].find((i) =>
          keys.get(i).equals(getAssociatedTokenAddressSync(mint, roles.trader))
        );
        const traderIndex = [...Array(keys.length).keys()].find((i) =>
          keys.get(i).equals(roles.trader)
        );
        const balance = (balances) =>
          BigInt(
            balances.find(
              (item) =>
                item.accountIndex === baseIndex &&
                item.mint === coin.mint &&
                item.owner === roles.trader.toBase58()
            )?.uiTokenAmount.amount ?? '0'
          );
        const executed = {
          amountIn: result.included_fee_input_amount.toString(),
          amountOut: event.excluded_transfer_fee_amount_out.toString(),
          totalFee: ['claiming_fee', 'protocol_fee', 'compounding_fee', 'referral_fee']
            .reduce((sum, key) => sum + BigInt(result[key].toString()), 0n)
            .toString(),
          baseDelta: (
            balance(receipt.meta.postTokenBalances) - balance(receipt.meta.preTokenBalances)
          ).toString(),
          nativeDelta: (
            BigInt(receipt.meta.postBalances[traderIndex]) -
            BigInt(receipt.meta.preBalances[traderIndex])
          ).toString(),
          networkFee: String(receipt.meta.fee),
          claimingFee: result.claiming_fee.toString(),
          protocolFee: result.protocol_fee.toString(),
          compoundingFee: result.compounding_fee.toString(),
          referralFee: result.referral_fee.toString(),
        };
        record.executed = executed;
        record.slot = receipt.slot;
        record.messageDigest = crypto
          .createHash('sha256')
          .update(receipt.transaction.message.serialize())
          .digest('hex');
        save();
        record.comparison = compareDammExecution(record.prepared, executed);
        coin.dammTrades ??= [];
        if (!coin.dammTrades.includes(record.signature)) coin.dammTrades.push(record.signature);
        if (!state.transactions.some((item) => item.signature === record.signature))
          state.transactions.push({
            label: `${coin.mode}-damm-${side}-quote-compare`,
            signature: record.signature,
            slot: receipt.slot,
          });
        save();
        console.log(
          JSON.stringify({
            mode: coin.mode,
            side,
            signature: record.signature,
            slot: receipt.slot,
            prepared: record.prepared,
            executed,
            comparison: record.comparison,
          })
        );
      }
    }
    return state;
  }
  async function bindCoin(coin) {
    const mint = new PublicKey(coin.mint),
      pool = sdk.deriveDammV2PoolAddress(sdk.DAMM_V2_MIGRATION_FEE_ADDRESS[6], mint, NATIVE_MINT);
    if (
      !coin.migratedPool ||
      pool.toBase58() !== coin.migratedPool ||
      !coin.migrationPositionMints?.length
    )
      throw new Error('Verified graduation and its actual position mints are required');
    const addresses = abi.vaultAddresses(programId, mint);
    let chosen;
    for (const value of coin.migrationPositionMints) {
      const nftMint = new PublicKey(value),
        position = sdk.derivePositionAddress(nftMint),
        nftAccount = sdk.derivePositionNftAccount(nftMint);
      const [positionInfo, nftInfo] = await connection.getMultipleAccountsInfo(
        [position, nftAccount],
        'confirmed'
      );
      if (!positionInfo || !nftInfo) continue;
      if (
        !positionInfo.owner.equals(appRequire('@meteora-ag/cp-amm-sdk').CP_AMM_PROGRAM_ID) ||
        positionInfo.data.length !== 408
      )
        throw new Error('Wrong migrated position owner/layout');
      const nft = appRequire('@solana/spl-token').unpackAccount(nftAccount, nftInfo, nftInfo.owner);
      if (!nft.owner.equals(addresses.feeAuthority)) continue;
      const data = positionInfo.data,
        u128 = (offset) => data.readBigUInt64LE(offset) + (data.readBigUInt64LE(offset + 8) << 64n);
      const liquidity = {
        unlocked: u128(152).toString(),
        vested: u128(168).toString(),
        permanent: u128(184).toString(),
      };
      console.log(JSON.stringify({ mode: coin.mode, position: position.toBase58(), liquidity }));
      if (
        !data.subarray(8, 40).equals(pool.toBuffer()) ||
        !data.subarray(40, 72).equals(nftMint.toBuffer()) ||
        nft.amount !== 1n ||
        liquidity.unlocked !== '0' ||
        liquidity.vested !== '0' ||
        BigInt(liquidity.permanent) <= 0n
      )
        throw new Error('Actual position has unexpected mint, pool or withdrawable liquidity');
      if (chosen) throw new Error('Multiple program fee positions are outside the reviewed policy');
      chosen = { position, nftAccount, liquidity };
    }
    if (!chosen) throw new Error('No actual permanent program-controlled fee position');
    const current = await connection.getAccountInfo(addresses.coin);
    if (!current?.owner.equals(programId)) throw new Error('Missing native coin identity');
    const identity = stateAbi.decodeVaultCoin(current.data);
    if (identity.migratedPool.equals(PublicKey.default)) {
      const result = await send(
        `${coin.mode}-bind-migration`,
        new Transaction().add(
          abi.bindMigrationInstruction({
            programId,
            mint,
            operator: roles.operator,
            dbcPool: poolFor(coin),
            config: new PublicKey(state.config),
            pool,
            position: chosen.position,
            nftAccount: chosen.nftAccount,
          })
        ),
        'operator'
      );
      coin.bindSignature = result.signature;
      coin.bindSlot = result.slot;
    } else if (
      !identity.migratedPool.equals(pool) ||
      !identity.position.equals(chosen.position) ||
      !identity.nftTokenAccount.equals(chosen.nftAccount)
    )
      throw new Error('Native migrated identity is already bound differently');
    coin.position = chosen.position.toBase58();
    coin.nftAccount = chosen.nftAccount.toBase58();
    coin.positionLiquidity = chosen.liquidity;
    save();
  }
  async function bind() {
    for (const coin of state.coins) await bindCoin(coin);
    return state;
  }
  return {
    prepare,
    post,
    graduate,
    'graduate-unbound': () => graduate(false),
    bind,
    'damm-roundtrip': dammRoundtrip,
    state: () => state,
  };
}
module.exports = { createRehearsal, assertPinned, curveTemplate, assertPacket, rehearsalArguments };
if (require.main === module) {
  (async () => {
    const options = rehearsalArguments(process.argv.slice(2));
    const { createLocalSender } = require('./local-vm-sender.cjs');
    const rehearsal = await createRehearsal(
      await createLocalSender({ fixturePath: options.fixturePath }),
      {
        statePath: options.statePath,
      }
    );
    await rehearsal[options.phase]();
  })().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
