import { createHash } from 'node:crypto';
import { BorshCoder, type Idl } from '@coral-xyz/anchor';
import { PublicKey, Transaction, type Connection } from '@solana/web3.js';
import {
  DynamicBondingCurveClient,
  DynamicBondingCurveIdl,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  derivePositionAddress,
  derivePositionNftAccount,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CP_AMM_PROGRAM_ID, type PositionState } from '@meteora-ag/cp-amm-sdk';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackAccount } from '@solana/spl-token';
import bs58 from 'bs58';
import { bindMigrationInstruction, vaultAddresses } from '@/lib/vault/client';
import { decodeVaultCoin, decodeVaultSettings } from '@/lib/vault/state';
import { registeredCoin, registeredConfig } from './launchRegistry';
import { discoverMigrationBoundary, migrationHistoryBoundary } from './migrationRegistry';
import { assertReleasedMigrationPolicy, loadMigratedPool } from './damm';
import {
  assertFinalizedEvidence,
  readEvidenceAccount,
  requireInstruction,
  type FinalizedEvidence,
} from './economics/chainEvidence';

export type MigrationBindingExpectation = { pool: string; position: string; nftAccount: string };
const coder = new BorshCoder(DynamicBondingCurveIdl as unknown as Idl);
/** Private unsigned operator step; users never receive or hold the fee-authority key. */
export async function prepareVaultMigrationBinding(args: {
  rpc: Connection;
  networkGenesis: string;
  programId: PublicKey;
  mint: PublicKey;
  operator: PublicKey;
}) {
  if ((await args.rpc.getGenesisHash()) !== args.networkGenesis)
    throw new Error('Binding network mismatch');
  const registered = await registeredCoin(args.networkGenesis, args.mint.toBase58());
  if (!registered || registered.policy_version !== 'rinse-v1')
    throw new Error('Reviewed immutable launch is required');
  const reviewed = await registeredConfig(args.networkGenesis, registered.config_key),
    addresses = vaultAddresses(args.programId, args.mint);
  const snapshot = await args.rpc.getMultipleAccountsInfoAndContext(
    [
      args.programId,
      addresses.settings,
      addresses.coin,
      new PublicKey(registered.dbc_pool),
      new PublicKey(registered.config_key),
    ],
    { commitment: 'finalized' }
  );
  const [program, settingsInfo, coinInfo, dbcInfo, configInfo] = snapshot.value;
  if (
    !program?.executable ||
    !settingsInfo?.owner.equals(args.programId) ||
    !coinInfo?.owner.equals(args.programId) ||
    !dbcInfo?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID) ||
    !configInfo?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)
  )
    throw new Error('Invalid native or protocol binding accounts');
  const settings = decodeVaultSettings(settingsInfo.data),
    native = decodeVaultCoin(coinInfo.data),
    hash = createHash('sha256').update(configInfo.data).digest('hex');
  if (
    settings.paused ||
    !settings.operator.equals(args.operator) ||
    !reviewed ||
    reviewed.policy_version !== 'rinse-v1' ||
    hash !== reviewed.config_digest ||
    hash !== native.configHash ||
    !native.mint.equals(args.mint) ||
    native.pool.toBase58() !== registered.dbc_pool ||
    native.config.toBase58() !== registered.config_key ||
    native.creator.toBase58() !== registered.original_deployer ||
    native.mode !== registered.mode ||
    native.activationTime !== BigInt(registered.activation_point)
  )
    throw new Error('Binding operator or immutable policy differs from custody');
  const client = new DynamicBondingCurveClient(args.rpc, 'finalized'),
    config = await client.state.getPoolConfig(registered.config_key),
    dbc = await client.state.getPool(registered.dbc_pool);
  if (
    !config ||
    !dbc ||
    Number(dbc.poolState.isMigrated) !== 1 ||
    !dbc.poolState.baseMint.equals(args.mint) ||
    dbc.poolState.config.toBase58() !== registered.config_key ||
    !config.feeClaimer.equals(addresses.feeAuthority)
  )
    throw new Error('The immutable DBC launch has not actually graduated');
  const migrated = await loadMigratedPool(args.rpc, config, args.mint, 'finalized');
  assertReleasedMigrationPolicy(migrated.state, args.mint);
  const candidates: Array<{ position: PublicKey; nftAccount: PublicKey; nftMint?: PublicKey }> = [];
  if (!native.migratedPool.equals(PublicKey.default)) {
    if (!native.migratedPool.equals(migrated.address))
      throw new Error('Native migration is bound to another pool');
    candidates.push({ position: native.position, nftAccount: native.nftTokenAccount });
  } else {
    const boundary =
      (await migrationHistoryBoundary(args.networkGenesis, args.mint.toBase58())) ??
      (await discoverMigrationBoundary(args.networkGenesis, args.mint.toBase58()));
    if (!boundary) throw new Error('Finalized canonical migration transaction history is required');
    const tx = await args.rpc.getTransaction(boundary.signature, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    if (!tx || !tx.meta || tx.meta.err || tx.transaction.signatures[0] !== boundary.signature)
      throw new Error('Finalized migration proof is unavailable');
    const keys = tx.transaction.message.getAccountKeys({
        accountKeysFromLookups: tx.meta.loadedAddresses,
      }),
      definition = DynamicBondingCurveIdl.instructions.find(
        (ix) => ix.name === 'migration_damm_v2'
      );
    if (!definition) throw new Error('Missing migration ABI');
    const instructions = [
      ...tx.transaction.message.compiledInstructions.map((ix) => ({
        programIdIndex: ix.programIdIndex,
        accounts: [...ix.accountKeyIndexes],
        data: Buffer.from(ix.data),
      })),
      ...(tx.meta.innerInstructions ?? []).flatMap((group) =>
        group.instructions.map((ix) => ({
          programIdIndex: ix.programIdIndex,
          accounts: ix.accounts,
          data: Buffer.from(bs58.decode(ix.data)),
        }))
      ),
    ];
    for (const ix of instructions) {
      if (!keys.get(ix.programIdIndex)?.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) continue;
      if (coder.instruction.decode(ix.data)?.name !== definition.name) continue;
      const account = (name: string) => {
        const offset = definition.accounts.findIndex((value) => value.name === name),
          index = ix.accounts[offset];
        if (index === undefined) throw new Error('Missing migration position account');
        const key = keys.get(index);
        if (!key) throw new Error('Missing migration position key');
        return key;
      };
      if (
        !account('base_mint').equals(args.mint) ||
        account('virtual_pool').toBase58() !== registered.dbc_pool ||
        account('config').toBase58() !== registered.config_key ||
        !account('pool').equals(migrated.address)
      )
        continue;
      for (const prefix of ['first', 'second'])
        candidates.push({
          position: account(`${prefix}_position`),
          nftAccount: account(`${prefix}_position_nft_account`),
          nftMint: account(`${prefix}_position_nft_mint`),
        });
    }
  }
  let selected: MigrationBindingExpectation | undefined;
  for (const candidate of candidates) {
    const [positionInfo, nftInfo] = await args.rpc.getMultipleAccountsInfo(
      [candidate.position, candidate.nftAccount],
      'finalized'
    );
    if (!positionInfo && !nftInfo) continue;
    if (
      !positionInfo?.owner.equals(CP_AMM_PROGRAM_ID) ||
      positionInfo.data.length !== 408 ||
      !nftInfo ||
      (!nftInfo.owner.equals(TOKEN_PROGRAM_ID) && !nftInfo.owner.equals(TOKEN_2022_PROGRAM_ID))
    )
      throw new Error('Invalid actual migrated position/NFT');
    const position = migrated.client._program.coder.accounts.decode<PositionState>(
        'position',
        positionInfo.data
      ),
      nft = unpackAccount(candidate.nftAccount, nftInfo, nftInfo.owner);
    if (!nft.owner.equals(addresses.feeAuthority)) continue;
    if (
      !position.pool.equals(migrated.address) ||
      !nft.mint.equals(position.nftMint) ||
      (candidate.nftMint && !candidate.nftMint.equals(position.nftMint)) ||
      !derivePositionAddress(position.nftMint).equals(candidate.position) ||
      !derivePositionNftAccount(position.nftMint).equals(candidate.nftAccount) ||
      nft.amount !== 1n ||
      !nft.isInitialized ||
      nft.isFrozen ||
      nft.delegate ||
      nft.closeAuthority ||
      !position.unlockedLiquidity.isZero() ||
      !position.vestedLiquidity.isZero() ||
      position.permanentLockedLiquidity.lten(0)
    )
      throw new Error('Position is outside permanent exclusive program fee custody');
    if (selected)
      throw new Error('Multiple fee positions are outside the reviewed migration policy');
    selected = {
      pool: migrated.address.toBase58(),
      position: candidate.position.toBase58(),
      nftAccount: candidate.nftAccount.toBase58(),
    };
  }
  if (!selected) throw new Error('No canonical permanent program fee position was found');
  if (!native.migratedPool.equals(PublicKey.default))
    return { status: 'already-bound' as const, expected: selected };
  const instruction = bindMigrationInstruction({
      programId: args.programId,
      mint: args.mint,
      operator: args.operator,
      dbcPool: native.pool,
      config: native.config,
      pool: new PublicKey(selected.pool),
      position: new PublicKey(selected.position),
      nftAccount: new PublicKey(selected.nftAccount),
    }),
    latest = await args.rpc.getLatestBlockhash('finalized');
  const tx = new Transaction({ feePayer: args.operator, recentBlockhash: latest.blockhash }).add(
    instruction
  );
  return {
    status: 'prepared' as const,
    instruction,
    transactionBase64: tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64'),
    lastValidBlockHeight: latest.lastValidBlockHeight,
    expected: selected,
    intentKey: `bind:${args.mint.toBase58()}:${selected.pool}`,
  };
}

export async function verifyFinalizedMigrationBinding(
  evidence: FinalizedEvidence,
  program: PublicKey,
  mint: PublicKey,
  expected: MigrationBindingExpectation
) {
  assertFinalizedEvidence(evidence);
  const addresses = vaultAddresses(program, mint),
    [coinInfo, settingsInfo] = await Promise.all([
      readEvidenceAccount(evidence, addresses.coin),
      readEvidenceAccount(evidence, addresses.settings),
    ]);
  if (!coinInfo?.owner.equals(program) || !settingsInfo?.owner.equals(program))
    throw new Error('Missing finalized native binding state');
  const coin = decodeVaultCoin(coinInfo.data),
    settings = decodeVaultSettings(settingsInfo.data);
  if (
    !coin.mint.equals(mint) ||
    coin.migratedPool.toBase58() !== expected.pool ||
    coin.position.toBase58() !== expected.position ||
    coin.nftTokenAccount.toBase58() !== expected.nftAccount
  )
    throw new Error('Finalized native binding does not match the reviewed operator plan');
  const instruction = bindMigrationInstruction({
    programId: program,
    mint,
    operator: settings.operator,
    dbcPool: coin.pool,
    config: coin.config,
    pool: new PublicKey(expected.pool),
    position: new PublicKey(expected.position),
    nftAccount: new PublicKey(expected.nftAccount),
  });
  requireInstruction(evidence, {
    program: program.toBase58(),
    accounts: instruction.keys.map((key) => key.pubkey.toBase58()),
    data: instruction.data,
  });
  return { ...expected, signature: evidence.signature, slot: evidence.slot };
}
