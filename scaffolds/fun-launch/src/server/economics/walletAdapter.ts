import { isWalletPolicy } from '@/lib/launchModes';
import modePolicy from '@/constants/modePolicy.json';
import { randomUUID } from 'node:crypto';
import { BorshInstructionCoder, type Idl } from '@coral-xyz/anchor';
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  unpackMint,
  unpackAccount,
} from '@solana/spl-token';
import {
  DynamicBondingCurveClient,
  DynamicBondingCurveIdl,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  deriveDbcPoolAuthority,
  deriveDbcEventAuthority,
  deriveDammV2PoolAuthority,
  deriveDammV2EventAuthority,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CP_AMM_PROGRAM_ID, getUnClaimLpFee } from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import { registeredCoin, type RegisteredCoin } from '../launchRegistry';
import { verifyConfigAccount, verifyLaunchConfig } from '../launchConfig';
import { loadMigratedPool, assertReleasedMigrationPolicy, migratedSwap } from '../damm';
import { FinalizedVerifier, messageDigest } from './chainEvidence';
import { verifyWalletEffect, WALLET_MEMO_PROGRAM } from './walletEvidence';
import { assertWalletExecutionGate } from './walletGate';
import { walletMigrationPosition } from './walletPosition';
import { assertWalletRecipientCredit } from './walletRecipient';
import { walletOperatingCosts } from './walletOperatingCosts';
import { isHsolMode } from '@/lib/feeModes';
import { isMskdMode } from '@/lib/launchModes';
import { buildMskdSwap } from './walletMskdSwap';
import { mskdPayoutMint } from './walletMskdPolicy';
import type {
  PreparedWalletExecution,
  WalletChainAdapter,
  WalletExpectations,
  WalletFeeObservation,
  WalletJob,
  WalletJobKind,
} from './walletTypes';

const u64 = (n: bigint) => {
  if (n <= 0n || n > 18446744073709551615n) throw new Error('Invalid wallet execution amount');
  return new BN(n.toString());
};
export class WalletCollectionUnavailable extends Error {
  override readonly name = 'WalletCollectionUnavailable';
  constructor() {
    super('No matching owned quote fees are currently collectible');
  }
}
export class WalletBuybackUnavailable extends Error {
  override readonly name = 'WalletBuybackUnavailable';
  constructor() {
    super('The remaining buyback budget cannot currently purchase a burnable token amount');
  }
}
export class MeteoraWalletAdapter implements WalletChainAdapter {
  constructor(
    private readonly rpc: Connection,
    private readonly genesis: string,
    private readonly collector: PublicKey,
    private readonly slippageBps = 100
  ) {
    if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 100)
      throw new Error('Invalid buyback slippage limit');
  }
  private async state(coin: RegisteredCoin) {
    const wallets = await assertWalletExecutionGate(this.rpc, this.genesis, { worker: true });
    const saved = await registeredCoin(this.genesis, coin.mint);
    if (
      !wallets.collector.equals(this.collector) ||
      !saved ||
      !isWalletPolicy(saved.policy_version) ||
      saved.network_genesis !== coin.network_genesis ||
      [
        'mint',
        'dbc_pool',
        'config_key',
        'quote_mint',
        'policy_version',
        'original_deployer',
        'mode',
        'recipient',
        'activation_point',
      ].some((key) => saved[key as keyof RegisteredCoin] !== coin[key as keyof RegisteredCoin])
    )
      throw new Error('Immutable wallet launch identity mismatch');
    const mint = new PublicKey(coin.mint),
      configKey = new PublicKey(coin.config_key),
      poolKey = new PublicKey(coin.dbc_pool);
    const client = new DynamicBondingCurveClient(this.rpc, 'finalized');
    const [config, pool, digest, mintInfo, poolInfo] = await Promise.all([
      client.state.getPoolConfig(configKey),
      client.state.getPool(poolKey),
      verifyConfigAccount(this.rpc, configKey),
      this.rpc.getAccountInfo(mint, 'finalized'),
      this.rpc.getAccountInfo(poolKey, 'finalized'),
    ]);
    if (
      !config ||
      !pool ||
      !poolInfo?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID) ||
      !mintInfo?.owner.equals(TOKEN_PROGRAM_ID) ||
      !pool.poolState.baseMint.equals(mint) ||
      !pool.poolState.config.equals(configKey) ||
      pool.poolState.activationPoint.toString() !== coin.activation_point
    )
      throw new Error('Invalid finalized wallet launch accounts');
    const token = unpackMint(mint, mintInfo, TOKEN_PROGRAM_ID);
    if (token.decimals !== 6 || token.mintAuthority || token.freezeAuthority)
      throw new Error('Token has mutable supply or freeze authority');
    await verifyLaunchConfig(this.genesis, configKey, config, digest, coin.mode, {
      allowDisabled: true,
      allowLegacy: true,
    });
    if (coin.quote_mint && coin.quote_mint !== config.quoteMint.toBase58())
      throw new Error('Quote asset differs from immutable coin');
    const tokenAta = getAssociatedTokenAddressSync(mint, this.collector),
      quoteAta = getAssociatedTokenAddressSync(config.quoteMint, this.collector);
    for (const address of [tokenAta, quoteAta]) {
      const info = await this.rpc.getAccountInfo(address, 'finalized');
      if (!info) continue;
      if (!info.owner.equals(TOKEN_PROGRAM_ID))
        throw new Error('Invalid collector token account program');
      const account = unpackAccount(address, info, TOKEN_PROGRAM_ID);
      if (
        !account.owner.equals(this.collector) ||
        account.delegate ||
        account.closeAuthority ||
        account.isFrozen ||
        !account.isInitialized ||
        !account.mint.equals(address.equals(quoteAta) ? config.quoteMint : mint)
      )
        throw new Error('Collector token account is not exclusively controlled');
    }
    return { coin: saved, mint, configKey, poolKey, client, config, pool, tokenAta, quoteAta };
  }
  private accounts(s: Awaited<ReturnType<MeteoraWalletAdapter['state']>>) {
    return [
      createAssociatedTokenAccountIdempotentInstruction(
        this.collector,
        s.tokenAta,
        this.collector,
        s.mint
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        this.collector,
        s.quoteAta,
        this.collector,
        s.config.quoteMint
      ),
    ];
  }
  private async prepared(
    coin: RegisteredCoin,
    kind: WalletJobKind,
    instructions: TransactionInstruction[],
    expectations: WalletExpectations
  ): Promise<PreparedWalletExecution> {
    const latest = await this.rpc.getLatestBlockhashAndContext('finalized'),
      memo = `RINSED:${randomUUID()}`;
    const tx = new Transaction({
      feePayer: this.collector,
      recentBlockhash: latest.value.blockhash,
    }).add(
      ...instructions,
      new TransactionInstruction({
        programId: WALLET_MEMO_PROGRAM,
        keys: [],
        data: Buffer.from(memo),
      })
    );
    const fee = await this.rpc.getFeeForMessage(tx.compileMessage(), 'finalized');
    if (!Number.isSafeInteger(fee.value) || fee.value! <= 0)
      throw new Error('Operating costs are unavailable');
    const maximumFee = BigInt(fee.value!) * 2n;
    const costs = await walletOperatingCosts(
      this.rpc,
      kind,
      maximumFee,
      typeof expectations.tokenAta === 'string' ? new PublicKey(expectations.tokenAta) : undefined,
      typeof expectations.quoteAta === 'string' ? new PublicKey(expectations.quoteAta) : undefined,
      typeof expectations.payoutMint === 'string' ||
        (!!coin.quote_mint && coin.quote_mint !== NATIVE_MINT.toBase58())
    );
    const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    if (wire.length > 1232) throw new Error('Wallet execution exceeds the transaction size limit');
    await assertWalletExecutionGate(this.rpc, this.genesis, { worker: true });
    return {
      networkGenesis: this.genesis,
      mint: coin.mint,
      kind,
      transactionBase64: wire.toString('base64'),
      messageDigest: messageDigest(tx.serializeMessage()),
      lastValidBlockHeight: latest.value.lastValidBlockHeight,
      preparedSlot: latest.context.slot,
      expectations: {
        ...expectations,
        ...(coin.quote_mint ? { quoteMint: coin.quote_mint } : {}),
        memo,
        maximumFeeLamports: maximumFee.toString(),
        operatingCostLamports: costs.operatingCostLamports.toString(),
        temporaryFundingLamports: costs.temporaryFundingLamports.toString(),
      },
    };
  }
  async prepareSetup({ coin }: { coin: RegisteredCoin }) {
    const s = await this.state(coin);
    return this.prepared(coin, 'setup', this.accounts(s), {
      collector: this.collector.toBase58(),
      pool: coin.dbc_pool,
      tokenAta: s.tokenAta.toBase58(),
      quoteAta: s.quoteAta.toBase58(),
    });
  }
  async prepareCollection({
    coin,
    events,
    maximumQuoteLamports,
  }: {
    coin: RegisteredCoin;
    events: WalletFeeObservation[];
    maximumQuoteLamports: bigint;
  }) {
    u64(maximumQuoteLamports);
    const s = await this.state(coin);
    if (
      !events.length ||
      events.some((e) => e.net <= 0n || e.pool !== events[0]!.pool) ||
      events.reduce((n, e) => n + e.net, 0n) !== maximumQuoteLamports
    )
      throw new Error('A bounded collection must match its reserved fee events');
    let ix: TransactionInstruction,
      quoteVault: PublicKey,
      pool: PublicKey,
      route: 'dbc' | 'damm-v2';
    if (events[0]!.pool === coin.dbc_pool) {
      if (s.pool.poolState.partnerQuoteFee.lt(u64(maximumQuoteLamports)))
        throw new WalletCollectionUnavailable();
      const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({
        pubkey,
        isWritable,
        isSigner,
      });
      pool = s.poolKey;
      quoteVault = s.pool.poolState.quoteVault;
      route = 'dbc';
      ix = new TransactionInstruction({
        programId: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
        keys: [
          meta(deriveDbcPoolAuthority()),
          meta(s.configKey),
          meta(pool, true),
          meta(s.tokenAta, true),
          meta(s.quoteAta, true),
          meta(s.pool.poolState.baseVault, true),
          meta(quoteVault, true),
          meta(s.mint),
          meta(s.config.quoteMint),
          meta(this.collector, false, true),
          meta(TOKEN_PROGRAM_ID),
          meta(TOKEN_PROGRAM_ID),
          meta(deriveDbcEventAuthority()),
          meta(DYNAMIC_BONDING_CURVE_PROGRAM_ID),
        ],
        data: new BorshInstructionCoder(DynamicBondingCurveIdl as unknown as Idl).encode(
          'claim_trading_fee2',
          {
            max_amount_a: new BN(0),
            max_amount_b: u64(maximumQuoteLamports),
            transfer_hook_accounts_info: { slices: [] },
          }
        ),
      });
    } else {
      if (Number(s.pool.poolState.isMigrated) !== 1)
        throw new Error('DBC launch has not graduated');
      const loaded = await loadMigratedPool(this.rpc, s.config, s.mint, 'finalized');
      assertReleasedMigrationPolicy(
        loaded.state,
        s.mint,
        coin.policy_version === 'bond-v1' ? 100 : 125,
        s.config.quoteMint
      );
      if (events[0]!.pool !== loaded.address.toBase58() || events.some((e) => e.phase !== 1))
        throw new Error('Invalid graduated collection route');
      const position = await walletMigrationPosition(this.rpc, coin, this.collector, loaded);
      const claimable = getUnClaimLpFee(loaded.state, position.state);
      if (!claimable.feeTokenA.isZero())
        throw new Error('Graduated position has unsupported base-token fee income');
      if (claimable.feeTokenB.lten(0)) throw new WalletCollectionUnavailable();
      pool = loaded.address;
      quoteVault = loaded.state.tokenBVault;
      route = 'damm-v2';
      ix = await loaded.client._program.methods
        .claimPositionFee()
        .accountsStrict({
          poolAuthority: deriveDammV2PoolAuthority(),
          pool,
          position: position.position,
          tokenAAccount: s.tokenAta,
          tokenBAccount: s.quoteAta,
          tokenAVault: loaded.state.tokenAVault,
          tokenBVault: quoteVault,
          tokenAMint: s.mint,
          tokenBMint: s.config.quoteMint,
          positionNftAccount: position.nftAccount,
          signer: this.collector,
          tokenAProgram: TOKEN_PROGRAM_ID,
          tokenBProgram: TOKEN_PROGRAM_ID,
          eventAuthority: deriveDammV2EventAuthority(),
          program: CP_AMM_PROGRAM_ID,
        })
        .instruction();
    }
    return this.prepared(
      coin,
      'collect',
      [
        ...this.accounts(s),
        ix,
        ...(s.config.quoteMint.equals(NATIVE_MINT)
          ? [createCloseAccountInstruction(s.quoteAta, this.collector, this.collector)]
          : []),
      ],
      {
        collector: this.collector.toBase58(),
        pool: pool.toBase58(),
        route,
        sourceQuoteVault: quoteVault.toBase58(),
        tokenAta: s.tokenAta.toBase58(),
        quoteAta: s.quoteAta.toBase58(),
        expectedLamports: maximumQuoteLamports.toString(),
        instruction: {
          program: ix.programId.toBase58(),
          accounts: ix.keys.map((k) => k.pubkey.toBase58()),
          dataBase64: ix.data.toString('base64'),
        },
      }
    );
  }
  async prepareBuyback(
    { coin, maximumSpendLamports }: { coin: RegisteredCoin; maximumSpendLamports: bigint },
    targetTokens?: bigint
  ) {
    const amount = u64(maximumSpendLamports),
      s = await this.state(coin),
      clock = await new FinalizedVerifier(this.rpc, this.genesis).clock();
    if (coin.mode !== 'bond' && BigInt(clock.blockTime) < BigInt(coin.activation_point) + 27n)
      throw new Error('Buybacks wait until RINSE has ended');
    let ix: TransactionInstruction,
      burn: BN,
      pool: PublicKey,
      baseVault: PublicKey,
      quoteVault: PublicKey,
      route: 'dbc' | 'damm-v2';
    if (Number(s.pool.poolState.isMigrated) === 1) {
      const loaded = await loadMigratedPool(this.rpc, s.config, s.mint, 'finalized');
      assertReleasedMigrationPolicy(
        loaded.state,
        s.mint,
        coin.policy_version === 'bond-v1' ? 100 : 125,
        s.config.quoteMint
      );
      const quote = await migratedSwap(
        this.rpc,
        s.config,
        s.mint,
        'buy',
        amount,
        this.slippageBps,
        undefined,
        'finalized'
      );
      burn = targetTokens === undefined ? quote.minimumAmountOut : u64(targetTokens);
      if (burn.gt(quote.minimumAmountOut))
        throw new Error('Prepared buyback no longer meets its minimum output');
      pool = loaded.address;
      baseVault = loaded.state.tokenAVault;
      quoteVault = loaded.state.tokenBVault;
      route = 'damm-v2';
      ix = await loaded.client._program.methods
        .swap2({ amount0: burn, amount1: amount, swapMode: 2 })
        .accountsStrict({
          poolAuthority: deriveDammV2PoolAuthority(),
          pool,
          inputTokenAccount: s.quoteAta,
          outputTokenAccount: s.tokenAta,
          tokenAVault: baseVault,
          tokenBVault: quoteVault,
          tokenAMint: s.mint,
          tokenBMint: s.config.quoteMint,
          payer: this.collector,
          tokenAProgram: TOKEN_PROGRAM_ID,
          tokenBProgram: TOKEN_PROGRAM_ID,
          referralTokenAccount: null,
          eventAuthority: deriveDammV2EventAuthority(),
          program: CP_AMM_PROGRAM_ID,
        })
        .instruction();
    } else {
      const quote = s.client.pool.swapQuote({
        virtualPool: s.pool,
        config: s.config,
        swapBaseForQuote: false,
        amountIn: amount,
        slippageBps: this.slippageBps,
        hasReferral: false,
        eligibleForFirstSwapWithMinFee: false,
        currentPoint: new BN(s.config.activationType === 0 ? clock.slot : clock.blockTime),
      });
      burn = targetTokens === undefined ? quote.minimumAmountOut : u64(targetTokens);
      if (burn.gt(quote.minimumAmountOut))
        throw new Error('Prepared buyback no longer meets its minimum output');
      pool = s.poolKey;
      baseVault = s.pool.poolState.baseVault;
      quoteVault = s.pool.poolState.quoteVault;
      route = 'dbc';
      ix = await s.client.pool.program.methods
        .swap2({ amount0: burn, amount1: amount, swapMode: 2 })
        .accountsStrict({
          poolAuthority: deriveDbcPoolAuthority(),
          config: s.configKey,
          pool,
          inputTokenAccount: s.quoteAta,
          outputTokenAccount: s.tokenAta,
          baseVault,
          quoteVault,
          baseMint: s.mint,
          quoteMint: NATIVE_MINT,
          payer: this.collector,
          tokenBaseProgram: TOKEN_PROGRAM_ID,
          tokenQuoteProgram: TOKEN_PROGRAM_ID,
          referralTokenAccount: null,
          eventAuthority: deriveDbcEventAuthority(),
          program: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
        })
        .instruction();
    }
    if (burn.lten(0)) throw new WalletBuybackUnavailable();
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      ...this.accounts(s),
      SystemProgram.transfer({
        fromPubkey: this.collector,
        toPubkey: s.quoteAta,
        lamports: maximumSpendLamports,
      }),
      createSyncNativeInstruction(s.quoteAta),
      ix,
      createBurnCheckedInstruction(s.tokenAta, s.mint, this.collector, BigInt(burn.toString()), 6),
      createCloseAccountInstruction(s.quoteAta, this.collector, this.collector),
    ];
    return this.prepared(coin, 'buyback', instructions, {
      collector: this.collector.toBase58(),
      pool: pool.toBase58(),
      route,
      sourceTokenVault: baseVault.toBase58(),
      sourceQuoteVault: quoteVault.toBase58(),
      tokenAta: s.tokenAta.toBase58(),
      quoteAta: s.quoteAta.toBase58(),
      burnTokens: burn.toString(),
      maximumSpendLamports: maximumSpendLamports.toString(),
      effect: 'buyback_burn',
      slippageBps: this.slippageBps,
      instruction: {
        program: ix.programId.toBase58(),
        accounts: ix.keys.map((k) => k.pubkey.toBase58()),
        dataBase64: ix.data.toString('base64'),
      },
    });
  }
  async preparePayout(job: WalletJob) {
    const coin = await registeredCoin(this.genesis, job.mint);
    if (
      !coin ||
      job.network_genesis !== this.genesis ||
      !job.kind.endsWith('_claim') ||
      !job.recipient
    )
      throw new Error('Invalid reserved payout');
    const state = await this.state(coin);
    const recipient = new PublicKey(job.recipient),
      amount = BigInt(job.lamports);
    u64(amount);
    const expected =
      job.kind === 'creator_claim'
        ? coin.original_deployer
        : job.kind === 'platform_claim'
          ? (
              await assertWalletExecutionGate(this.rpc, this.genesis, { worker: true })
            ).treasury.toBase58()
          : job.recipient;
    if (expected !== job.recipient || !PublicKey.isOnCurve(recipient.toBytes()))
      throw new Error('Payout beneficiary differs from the immutable mode');
    const wrappedMonero = isMskdMode(coin.mode) && job.kind === 'community_claim';
    if (wrappedMonero || isHsolMode(coin.mode)) {
      const mint = wrappedMonero ? mskdPayoutMint(this.genesis) : state.config.quoteMint;
      if (
        !mint ||
        (wrappedMonero && recipient.equals(this.collector)) ||
        (isHsolMode(coin.mode) &&
          !wrappedMonero &&
          job.kind === 'community_claim' &&
          coin.mode !== 'cashback-hsol') ||
        (job.kind !== 'platform_claim' && job.details.assetMint !== mint.toBase58())
      )
        throw new Error('Token payout differs from the immutable asset and owner');
      const destination = getAssociatedTokenAddressSync(mint, recipient);
      return this.prepared(
        coin,
        job.kind,
        [
          createAssociatedTokenAccountIdempotentInstruction(
            this.collector,
            destination,
            recipient,
            mint
          ),
          createTransferCheckedInstruction(
            getAssociatedTokenAddressSync(mint, this.collector),
            mint,
            destination,
            this.collector,
            amount,
            wrappedMonero ? modePolicy.payouts.wxmr.decimals : modePolicy.quotes.hsol.decimals
          ),
        ],
        {
          collector: this.collector.toBase58(),
          pool: coin.dbc_pool,
          recipient: job.recipient,
          quoteAta: destination.toBase58(),
          ...(wrappedMonero ? { payoutMint: mint.toBase58() } : {}),
          expectedLamports: amount.toString(),
        }
      );
    }
    if (!state.config.quoteMint.equals(NATIVE_MINT))
      throw new Error('Unreleased payout quote asset');
    await assertWalletRecipientCredit(this.rpc, recipient, amount);
    return this.prepared(
      coin,
      job.kind,
      [
        SystemProgram.transfer({
          fromPubkey: this.collector,
          toPubkey: recipient,
          lamports: amount,
        }),
      ],
      {
        collector: this.collector.toBase58(),
        pool: coin.dbc_pool,
        recipient: job.recipient,
        expectedLamports: amount.toString(),
      }
    );
  }
  async prepareHolderConversion(job: WalletJob, existing?: WalletExpectations) {
    const coin = await registeredCoin(this.genesis, job.mint);
    if (
      !coin ||
      !isMskdMode(coin.mode) ||
      job.details.sourceMint !== (isHsolMode(coin.mode) ? coin.quote_mint : undefined) ||
      job.network_genesis !== this.genesis ||
      job.kind !== 'holder_conversion'
    )
      throw new Error('Reviewed MSKD conversion job required');
    await this.state(coin);
    const { instructions, expectations } = await buildMskdSwap(
      this.rpc,
      this.collector,
      job,
      existing
    );
    return this.prepared(coin, job.kind, instructions, expectations);
  }
  verifyFinalized(job: WalletJob, evidence: Parameters<WalletChainAdapter['verifyFinalized']>[1]) {
    return verifyWalletEffect(this.rpc, job, evidence);
  }
}
