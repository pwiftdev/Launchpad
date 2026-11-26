import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import {
  NATIVE_MINT,
  unpackMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import {
  CpAmm,
  CP_AMM_PROGRAM_ID,
  getLiquidityHandler,
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
import { assertReviewedSwap, type ReviewedSwap } from './reviewedSwap';

export function migratedPoolAddress(config: PoolConfig, mint: PublicKey) {
  if (config.migrationOption !== 1 || config.quoteMint.equals(mint))
    throw new Error('Unsupported graduation route');
  const migrationConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption];
  if (!migrationConfig) throw new Error('Unknown DAMM v2 migration configuration');
  return deriveDammV2PoolAddress(migrationConfig, mint, config.quoteMint);
}
export function assertMigratedPair(
  state: Pick<PoolState, 'tokenAMint' | 'tokenBMint'>,
  mint: PublicKey,
  quote = NATIVE_MINT
) {
  if (
    !(state.tokenAMint.equals(mint) && state.tokenBMint.equals(quote)) &&
    !(state.tokenBMint.equals(mint) && state.tokenAMint.equals(quote))
  )
    throw new Error('Graduated pool mint pair does not match the launch');
}
/** Graduated new-policy fees are at their final floor; mode accounting starts immediately. */
export function assertReleasedMigrationPolicy(
  state: PoolState,
  mint: PublicKey,
  feeBps = 125,
  quote = NATIVE_MINT
) {
  assertMigratedPair(state, mint, quote);
  const base = decodePodAlignedFeeTimeScheduler(
    Buffer.from(state.poolFees.baseFee.baseFeeInfo.data)
  );
  if (
    state.activationType !== 1 ||
    !state.tokenAMint.equals(mint) ||
    !state.tokenBMint.equals(quote) ||
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
  assertMigratedPair(state, mint, config.quoteMint);
  return { address, state, client };
}
export function migratedPrice(
  state: Pick<PoolState, 'tokenAMint' | 'tokenBMint' | 'sqrtPrice'>,
  mint: PublicKey,
  decimals: number,
  quote = NATIVE_MINT
) {
  assertMigratedPair(state, mint, quote);
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

export function migratedQuoteReserve(state: PoolState, quote: PublicKey) {
  const quoteIsA = state.tokenAMint.equals(quote);
  if (!quoteIsA && !state.tokenBMint.equals(quote)) return undefined;
  const reserves =
    state.layoutVersion === 1
      ? [state.tokenAAmount, state.tokenBAmount]
      : state.layoutVersion === 0
        ? getLiquidityHandler(state).getReservesAmount()
        : [];
  const reserve = reserves[quoteIsA ? 0 : 1];
  return reserve && !reserve.isNeg() ? Number(reserve.toString()) / LAMPORTS_PER_SOL : undefined;
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
  commitment: 'confirmed' | 'finalized' = 'confirmed',
  reviewed?: ReviewedSwap
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
  const inputMint = side === 'buy' ? config.quoteMint : mint,
    outputMint = side === 'buy' ? mint : config.quoteMint;
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
  const feeSol = feeMint.equals(config.quoteMint)
    ? feeAmount
    : feeAmount * migratedPrice(state, mint, baseDecimals, config.quoteMint);
  if (reviewed) assertReviewedSwap(reviewed, address.toBase58(), quote.swapOutAmount);
  const minimumAmountOut = reviewed?.minimumAmountOut ?? quote.minSwapOutAmount;
  const transaction = owner
    ? await client.swap({
        payer: owner,
        pool: address,
        inputTokenMint: inputMint,
        outputTokenMint: outputMint,
        amountIn: units,
        minimumAmountOut,
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
    minimumAmountOut,
    feeMint: feeMint.toBase58(),
    feeAmount,
    feeSol,
    feeSolIsEstimate: !feeMint.equals(config.quoteMint),
    transaction,
    pool: address.toBase58(),
    stateSlot: slot,
  };
}
