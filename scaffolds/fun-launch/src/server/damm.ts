import { Connection, PublicKey } from '@solana/web3.js';
import {
  NATIVE_MINT,
  unpackMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import {
  CpAmm,
  CP_AMM_PROGRAM_ID,
  getTokenProgram,
  decodePodAlignedFeeTimeScheduler,
  type PoolState,
} from '@meteora-ag/cp-amm-sdk';
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  deriveDammV2PoolAddress,
  getPriceFromSqrtPrice,
  type PoolConfig,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import BN from 'bn.js';

export function migratedPoolAddress(config: PoolConfig, mint: PublicKey) {
  if (config.migrationOption !== 1 || !config.quoteMint.equals(NATIVE_MINT))
    throw new Error('Unsupported graduation route');
  const migrationConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption];
  if (!migrationConfig) throw new Error('Unknown DAMM v2 migration configuration');
  return deriveDammV2PoolAddress(migrationConfig, mint, config.quoteMint);
}
export function assertMigratedPair(
  state: Pick<PoolState, 'tokenAMint' | 'tokenBMint'>,
  mint: PublicKey
) {
  if (
    !(state.tokenAMint.equals(mint) && state.tokenBMint.equals(NATIVE_MINT)) &&
    !(state.tokenBMint.equals(mint) && state.tokenAMint.equals(NATIVE_MINT))
  )
    throw new Error('Graduated pool mint pair does not match the launch');
}
/** Graduated new-policy fees are at their final floor; mode accounting starts immediately. */
export function assertReleasedMigrationPolicy(state: PoolState, mint: PublicKey, feeBps = 125) {
  assertMigratedPair(state, mint);
  const base = decodePodAlignedFeeTimeScheduler(
    Buffer.from(state.poolFees.baseFee.baseFeeInfo.data)
  );
  if (
    state.activationType !== 1 ||
    !state.tokenAMint.equals(mint) ||
    !state.tokenBMint.equals(NATIVE_MINT) ||
    state.collectFeeMode !== 1 ||
    state.poolFees.dynamicFee.initialized !== 0 ||
    !base.cliffFeeNumerator.eqn(feeBps * 100_000) ||
    base.numberOfPeriod !== 0 ||
    !base.periodFrequency.isZero() ||
    !base.reductionFactor.isZero()
  )
    throw new Error('Graduated pool does not match the final fee policy');
}
export async function loadMigratedPool(
  connection: Connection,
  config: PoolConfig,
  mint: PublicKey,
  commitment: 'confirmed' | 'finalized' = 'confirmed'
) {
  const address = migratedPoolAddress(config, mint);
  const account = await connection.getAccountInfo(address, commitment);
  if (!account || !account.owner.equals(CP_AMM_PROGRAM_ID))
    throw new Error('Graduation is pending a valid DAMM v2 pool');
  const client = new CpAmm(connection);
  const state = client._program.coder.accounts.decode<PoolState>('pool', account.data);
  assertMigratedPair(state, mint);
  return { address, state, client };
}
export function migratedPrice(
  state: Pick<PoolState, 'tokenAMint' | 'tokenBMint' | 'sqrtPrice'>,
  mint: PublicKey,
  decimals: number
) {
  assertMigratedPair(state, mint);
  const baseIsA = state.tokenAMint.equals(mint);
  const price = Number(
    getPriceFromSqrtPrice(
      state.sqrtPrice,
      baseIsA ? decimals : 9,
      baseIsA ? 9 : decimals
    ).toString()
  );
  if (!Number.isFinite(price) || price <= 0) throw new Error('Invalid graduated pool price');
  return baseIsA ? price : 1 / price;
}

/** Quotes and builds only the deterministic migrated pool belonging to this DBC launch. */
export async function migratedSwap(
  connection: Connection,
  config: PoolConfig,
  mint: PublicKey,
  side: 'buy' | 'sell',
  units: BN,
  slippageBps: number,
  owner?: PublicKey,
  commitment: 'confirmed' | 'finalized' = 'confirmed'
) {
  const { address, state, client } = await loadMigratedPool(connection, config, mint, commitment);
  const accounts = await connection.getMultipleAccountsInfo(
    [state.tokenAMint, state.tokenBMint],
    commitment
  );
  const accountA = accounts[0],
    accountB = accounts[1];
  if (!accountA || !accountB) throw new Error('Missing pool mints');
  for (const account of [accountA, accountB])
    if (!account.owner.equals(TOKEN_PROGRAM_ID) && !account.owner.equals(TOKEN_2022_PROGRAM_ID))
      throw new Error('Invalid pool mint owner');
  const mintA = unpackMint(state.tokenAMint, accountA, accountA.owner),
    mintB = unpackMint(state.tokenBMint, accountB, accountB.owner);
  const [epoch, slot] = await Promise.all([
    connection.getEpochInfo(commitment),
    connection.getSlot(commitment),
  ]);
  const time = await connection.getBlockTime(slot);
  if (time === null) throw new Error('On-chain quote time unavailable');
  const inputMint = side === 'buy' ? NATIVE_MINT : mint,
    outputMint = side === 'buy' ? mint : NATIVE_MINT;
  const inputIsA = state.tokenAMint.equals(inputMint);
  const tokenAInfo = accountA.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? { mint: mintA, currentEpoch: epoch.epoch }
    : undefined;
  const tokenBInfo = accountB.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? { mint: mintB, currentEpoch: epoch.epoch }
    : undefined;
  const quote = client.getQuote({
    inAmount: units,
    inputTokenMint: inputMint,
    slippage: slippageBps / 100,
    poolState: state,
    currentTime: time,
    currentSlot: slot,
    inputTokenInfo: inputIsA ? tokenAInfo : tokenBInfo,
    outputTokenInfo: inputIsA ? tokenBInfo : tokenAInfo,
    tokenADecimal: mintA.decimals,
    tokenBDecimal: mintB.decimals,
    hasReferral: false,
  });
  // OnlyB collects in B; other legacy modes collect in the output token. Never label base tokens SOL.
  const feeMint = state.collectFeeMode === 1 ? state.tokenBMint : outputMint;
  const feeDecimals = feeMint.equals(state.tokenAMint) ? mintA.decimals : mintB.decimals;
  const feeAmount = Number(quote.totalFee.toString()) / 10 ** feeDecimals;
  const baseDecimals = state.tokenAMint.equals(mint) ? mintA.decimals : mintB.decimals;
  const feeSol = feeMint.equals(NATIVE_MINT)
    ? feeAmount
    : feeAmount * migratedPrice(state, mint, baseDecimals);
  const transaction = owner
    ? await client.swap({
        payer: owner,
        pool: address,
        inputTokenMint: inputMint,
        outputTokenMint: outputMint,
        amountIn: units,
        minimumAmountOut: quote.minSwapOutAmount,
        tokenAVault: state.tokenAVault,
        tokenBVault: state.tokenBVault,
        tokenAMint: state.tokenAMint,
        tokenBMint: state.tokenBMint,
        tokenAProgram: getTokenProgram(state.tokenAFlag),
        tokenBProgram: getTokenProgram(state.tokenBFlag),
        referralTokenAccount: null,
        poolState: state,
      })
    : undefined;
  return {
    amountOut: quote.swapOutAmount,
    minimumAmountOut: quote.minSwapOutAmount,
    feeMint: feeMint.toBase58(),
    feeAmount,
    feeSol,
    feeSolIsEstimate: !feeMint.equals(NATIVE_MINT),
    transaction,
    pool: address.toBase58(),
    stateSlot: slot,
  };
}
