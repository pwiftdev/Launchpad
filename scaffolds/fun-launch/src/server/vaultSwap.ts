import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk';
import {
  DynamicBondingCurveClient,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  deriveDbcPoolAuthority,
  deriveDbcEventAuthority,
  deriveDammV2PoolAuthority,
  deriveDammV2EventAuthority,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { vaultAddresses } from '@/lib/vault/client';
import { connection, dbc, getCoin, networkGenesis } from './dbc';
import { configuredVaultProgram } from './launchConfig';
import { registeredCoin } from './launchRegistry';
import { verifiedFinancialPool } from './migrationRegistry';
import { loadMigratedPool, migratedSwap, assertReleasedMigrationPolicy } from './damm';

/** Raw exact-input CPI only. The caller wraps, funds and atomically burns in the native vault. */
export async function prepareVaultSwap(args: {
  mint: PublicKey;
  coinPDA: PublicKey;
  amount: BN;
  slippageBps: number;
}) {
  if (
    args.amount.lten(0) ||
    args.amount.bitLength() > 64 ||
    !Number.isInteger(args.slippageBps) ||
    args.slippageBps < 0 ||
    args.slippageBps > 500
  )
    throw new Error('Invalid vault swap amount or slippage');
  const genesis = await networkGenesis(),
    mint = args.mint;
  const registered = await registeredCoin(genesis, mint.toBase58());
  if (!registered || registered.policy_version !== 'rinse-v1')
    throw new Error('Reviewed immutable launch is required');
  const addresses = vaultAddresses(configuredVaultProgram(), mint);
  if (!addresses.coin.equals(args.coinPDA)) throw new Error('Wrong coin custody PDA');
  const found = await getCoin(mint.toBase58());
  if (
    !found ||
    found.coin.pool !== registered.dbc_pool ||
    found.coin.configKey !== registered.config_key ||
    found.config.tokenType !== 0 ||
    found.config.quoteTokenFlag !== 0 ||
    !found.config.quoteMint.equals(NATIVE_MINT)
  )
    throw new Error('Vault route does not match the immutable SPL launch');
  const finalized = new DynamicBondingCurveClient(connection, 'finalized');
  const finalizedPool = await finalized.state.getPool(registered.dbc_pool);
  if (
    !finalizedPool ||
    !finalizedPool.poolState.config.equals(new PublicKey(registered.config_key)) ||
    !finalizedPool.poolState.baseMint.equals(mint)
  )
    throw new Error('Finalized launch identity mismatch');
  const stateSlot = await connection.getSlot('finalized');
  const now = await connection.getBlockTime(stateSlot);
  if (now === null) throw new Error('Finalized quote clock is unavailable');
  if (Number(finalizedPool.poolState.isMigrated) === 1) {
    const loaded = await loadMigratedPool(connection, found.config, mint, 'finalized');
    assertReleasedMigrationPolicy(loaded.state, mint);
    if (!(await verifiedFinancialPool(genesis, mint.toBase58(), loaded.address.toBase58())))
      throw new Error('Unverified graduated financial route');
    const quote = await migratedSwap(
      connection,
      found.config,
      mint,
      'buy',
      args.amount,
      args.slippageBps,
      undefined,
      'finalized'
    );
    const instruction = await loaded.client._program.methods
      .swap({
        amountIn: args.amount,
        minimumAmountOut: quote.minimumAmountOut,
      })
      .accountsStrict({
        poolAuthority: deriveDammV2PoolAuthority(),
        pool: loaded.address,
        inputTokenAccount: addresses.quoteAccount,
        outputTokenAccount: addresses.tokenAccount,
        tokenAVault: loaded.state.tokenAVault,
        tokenBVault: loaded.state.tokenBVault,
        tokenAMint: mint,
        tokenBMint: NATIVE_MINT,
        payer: args.coinPDA,
        tokenAProgram: TOKEN_PROGRAM_ID,
        tokenBProgram: TOKEN_PROGRAM_ID,
        referralTokenAccount: null,
        eventAuthority: deriveDammV2EventAuthority(),
        program: CP_AMM_PROGRAM_ID,
      })
      .instruction();
    return {
      route: 1 as const,
      pool: loaded.address,
      baseVault: loaded.state.tokenAVault,
      quoteVault: loaded.state.tokenBVault,
      programId: CP_AMM_PROGRAM_ID,
      instruction,
      stateSlot: quote.stateSlot,
      quote: { outputAmount: quote.amountOut, minimumAmountOut: quote.minimumAmountOut },
    };
  }
  const quote = dbc.pool.swapQuote({
    virtualPool: finalizedPool,
    config: found.config,
    swapBaseForQuote: false,
    amountIn: args.amount,
    slippageBps: args.slippageBps,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint: new BN(now),
  });
  const state = finalizedPool.poolState,
    pool = new PublicKey(registered.dbc_pool);
  const instruction = await dbc.pool.program.methods
    .swap({ amountIn: args.amount, minimumAmountOut: quote.minimumAmountOut })
    .accountsStrict({
      poolAuthority: deriveDbcPoolAuthority(),
      config: state.config,
      pool,
      inputTokenAccount: addresses.quoteAccount,
      outputTokenAccount: addresses.tokenAccount,
      baseVault: state.baseVault,
      quoteVault: state.quoteVault,
      baseMint: mint,
      quoteMint: NATIVE_MINT,
      payer: args.coinPDA,
      tokenBaseProgram: TOKEN_PROGRAM_ID,
      tokenQuoteProgram: TOKEN_PROGRAM_ID,
      referralTokenAccount: null,
      eventAuthority: deriveDbcEventAuthority(),
      program: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
    })
    .instruction();
  return {
    route: 0 as const,
    pool,
    baseVault: state.baseVault,
    quoteVault: state.quoteVault,
    programId: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
    instruction,
    stateSlot,
    quote: { outputAmount: quote.outputAmount, minimumAmountOut: quote.minimumAmountOut },
  };
}
