import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type AccountMeta,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  unpackAccount,
} from '@solana/spl-token';
import { BorshInstructionCoder, type Idl } from '@coral-xyz/anchor';
import {
  DynamicBondingCurveClient,
  DynamicBondingCurveIdl,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  deriveDbcPoolAuthority,
  deriveDbcEventAuthority,
  deriveDammV2PoolAuthority,
  deriveDammV2EventAuthority,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CP_AMM_PROGRAM_ID, type PositionState } from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import { verifyDammRealization } from './dammRealization';
import { FinancialDammCheckpointStore } from './checkpointStore';
import { assertCheckpointSigningConfigured } from './dammCheckpoint';
import {
  allocateCollectedFeesInstruction,
  collectFeesInstruction,
  vaultAddresses,
  epochAddress,
  u64,
  digest32,
} from '@/lib/vault/client';
import discriminators from '@/lib/vault/discriminators.json';
import { registeredCoin } from '../launchRegistry';
import { verifiedFinancialPool } from '../migrationRegistry';
import { loadMigratedPool, assertReleasedMigrationPolicy } from '../damm';
import { prepareVaultSwap } from '../vaultSwap';
import { type FinalizedClock } from './chainEvidence';
import { FinancialStore, type EventId, type FundingSourceKind } from './financialStore';
import type { BuybackAdapter, BuybackQuote } from './financialWorker';

const meta = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({
  pubkey,
  isWritable,
  isSigner,
});
export type OperatorTransaction = {
  transactionBase64: string;
  lastValidBlockHeight: number;
  instruction: TransactionInstruction;
};

/** Concrete SDK adapter; all outputs remain unsigned for an independent operator signer. */
export class VaultAccountSetupRequired extends Error {}
export class MeteoraFinancialAdapter implements BuybackAdapter {
  constructor(
    private readonly rpc: Connection,
    private readonly store: FinancialStore,
    private readonly program: PublicKey,
    private readonly operator: PublicKey,
    private readonly networkGenesis: string
  ) {}

  async state(mint: PublicKey) {
    if ((await this.rpc.getGenesisHash()) !== this.networkGenesis)
      throw new Error('Financial adapter network mismatch');
    const registered = await registeredCoin(this.networkGenesis, mint.toBase58());
    if (!registered || registered.policy_version !== 'rinse-v1')
      throw new Error('Reviewed immutable launch is required');
    const addresses = vaultAddresses(this.program, mint);
    const response = await this.rpc.getMultipleAccountsInfoAndContext(
      [addresses.settings, addresses.coin],
      { commitment: 'finalized' }
    );
    const settings = response.value[0],
      coin = response.value[1],
      data = coin?.data;
    if (
      !settings?.owner.equals(this.program) ||
      settings.data.length !== 107 ||
      settings.data.subarray(0, 8).toString() !== 'RSET0001' ||
      settings.data[8] !== 1 ||
      settings.data[10] !== 0 ||
      !settings.data.subarray(43, 75).equals(this.operator.toBuffer())
    )
      throw new Error('The configured operator is not authorized by unpaused vault settings');
    if (
      !coin?.owner.equals(this.program) ||
      !data ||
      data.length !== 347 ||
      data.subarray(0, 8).toString() !== 'RCOIN001' ||
      data[8] !== 1 ||
      !data.subarray(11, 43).equals(mint.toBuffer()) ||
      !data.subarray(43, 75).equals(new PublicKey(registered.dbc_pool).toBuffer()) ||
      !data.subarray(75, 107).equals(new PublicKey(registered.config_key).toBuffer()) ||
      !data.subarray(107, 139).equals(new PublicKey(registered.original_deployer).toBuffer()) ||
      data[10] !== Number(registered.mode === 'community') ||
      data.readBigInt64LE(139) !== BigInt(registered.activation_point)
    )
      throw new Error('Program custody state differs from the immutable coin registry');
    return {
      registered,
      addresses,
      slot: response.context.slot,
      data,
      buyback: data.readBigUInt64LE(147),
      nonce: data.readBigUInt64LE(179),
      migratedPool: new PublicKey(data.subarray(195, 227)),
      position: new PublicKey(data.subarray(227, 259)),
      nftAccount: new PublicKey(data.subarray(259, 291)),
      rinseNet: data.readBigUInt64LE(323),
      postNet: data.readBigUInt64LE(331),
      unallocatedCollected: data.readBigUInt64LE(339),
    };
  }

  private async unsigned(instruction: TransactionInstruction): Promise<OperatorTransaction> {
    const latest = await this.rpc.getLatestBlockhash('finalized');
    const tx = new Transaction({ feePayer: this.operator, recentBlockhash: latest.blockhash }).add(
      instruction
    );
    return {
      instruction,
      transactionBase64: tx
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString('base64'),
      lastValidBlockHeight: latest.lastValidBlockHeight,
    };
  }

  async setupAccounts(mint: PublicKey) {
    const { addresses } = await this.state(mint);
    const latest = await this.rpc.getLatestBlockhash('finalized');
    const tx = new Transaction({ feePayer: this.operator, recentBlockhash: latest.blockhash }).add(
      createAssociatedTokenAccountIdempotentInstruction(
        this.operator,
        addresses.quoteAccount,
        addresses.coin,
        NATIVE_MINT
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        this.operator,
        addresses.tokenAccount,
        addresses.coin,
        mint
      )
    );
    return {
      transactionBase64: tx
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString('base64'),
      lastValidBlockHeight: latest.lastValidBlockHeight,
      quoteAccount: addresses.quoteAccount.toBase58(),
      tokenAccount: addresses.tokenAccount.toBase58(),
    };
  }

  async requireAccounts(mint: PublicKey) {
    const addresses = vaultAddresses(this.program, mint);
    const accounts = await this.rpc.getMultipleAccountsInfo(
      [addresses.quoteAccount, addresses.tokenAccount],
      'finalized'
    );
    const quote = accounts[0],
      base = accounts[1];
    if (!quote || !base)
      throw new VaultAccountSetupRequired(
        'Initialize the coin token/empty WSOL ATAs in a separate confirmed setup transaction'
      );
    const a = unpackAccount(addresses.quoteAccount, quote, TOKEN_PROGRAM_ID),
      b = unpackAccount(addresses.tokenAccount, base, TOKEN_PROGRAM_ID);
    if (
      !a.owner.equals(addresses.coin) ||
      !a.mint.equals(NATIVE_MINT) ||
      !a.isNative ||
      a.amount !== 0n ||
      !b.owner.equals(addresses.coin) ||
      !b.mint.equals(mint)
    )
      throw new Error('Unexpected vault token account ownership or residual WSOL');
    return addresses;
  }

  async quote(input: {
    networkGenesis: string;
    mint: string;
    amount: bigint;
    clock: FinalizedClock;
    maximumSlippageBps: number;
  }): Promise<BuybackQuote> {
    if (
      input.networkGenesis !== this.networkGenesis ||
      input.clock.networkGenesis !== this.networkGenesis
    )
      throw new Error('Buyback network mismatch');
    const mint = new PublicKey(input.mint),
      state = await this.state(mint);
    const balance = (await this.store.balances(this.networkGenesis, input.mint)).find(
      (row) => row.bucket === 'rinse_buyback'
    );
    if (
      state.buyback !== BigInt(balance?.funded ?? '0') - BigInt(balance?.spent ?? '0') ||
      input.amount <= 0n ||
      input.amount > state.buyback
    )
      throw new Error(
        'Reconcile program custody and the funded buyback journal before preparing a spend'
      );
    await this.requireAccounts(mint);
    const swap = await prepareVaultSwap({
      mint,
      coinPDA: state.addresses.coin,
      amount: new BN(input.amount.toString()),
      slippageBps: input.maximumSlippageBps,
    });
    const quotedAtTime = await this.rpc.getBlockTime(swap.stateSlot);
    if (!Number.isSafeInteger(quotedAtTime))
      throw new Error('Finalized quote timestamp is unavailable');
    const min = BigInt(swap.quote.minimumAmountOut.toString()),
      deadline = BigInt(input.clock.blockTime + 30),
      length = Buffer.alloc(2);
    if (swap.instruction.data.length > 1000)
      throw new Error('Swap CPI exceeds the bounded instruction size');
    length.writeUInt16LE(swap.instruction.data.length);
    const keys = [
      meta(this.operator, true, true),
      meta(state.addresses.settings),
      meta(state.addresses.coin, true),
      meta(state.addresses.quoteAccount, true),
      meta(state.addresses.tokenAccount, true),
      meta(mint, true),
      meta(TOKEN_PROGRAM_ID),
      meta(swap.programId),
      ...swap.instruction.keys.map((key) => {
        if (key.isSigner && !key.pubkey.equals(state.addresses.coin))
          throw new Error('Unexpected external swap signer');
        return { ...key, isSigner: false };
      }),
    ];
    const data = Buffer.concat([
      Buffer.from(discriminators.execute_buyback_burn),
      u64(state.nonce),
      u64(input.amount),
      u64(min),
      u64(deadline),
      Buffer.from([swap.route]),
      length,
      swap.instruction.data,
    ]);
    const instruction = new TransactionInstruction({ programId: this.program, keys, data });
    const prepared = await this.unsigned(instruction);
    return {
      amountIn: input.amount,
      minimumTokens: min,
      slippageBps: input.maximumSlippageBps,
      quotedAtSlot: swap.stateSlot,
      quotedAtTime: quotedAtTime!,
      nonce: state.nonce,
      transactionBase64: prepared.transactionBase64,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
      expectation: {
        program: this.program.toBase58(),
        accounts: keys.map((key) => key.pubkey.toBase58()),
        dataBase64: data.toString('base64'),
        vault: state.addresses.coin.toBase58(),
        effect: 'buyback_burn',
        tokenAccount: state.addresses.tokenAccount.toBase58(),
        poolTokenVault: swap.baseVault.toBase58(),
        minTokens: min.toString(),
        unwrapAccount: state.addresses.quoteAccount.toBase58(),
      },
    };
  }

  async prepareFunding(mint: PublicKey, eventIds: EventId[], sourceKind?: FundingSourceKind) {
    const state = await this.state(mint);
    let plan = await this.store.previewFundingPlan(
      this.networkGenesis,
      mint.toBase58(),
      eventIds,
      sourceKind
    );
    if (plan.migrated && !plan.realization) {
      assertCheckpointSigningConfigured();
      const accounted = await this.store.dammAccountedTotals(
        this.networkGenesis,
        mint.toBase58(),
        plan.pool
      );
      const proof = await verifyDammRealization({
        rpc: this.rpc,
        genesis: this.networkGenesis,
        mint: mint.toBase58(),
        pool: plan.pool,
        rawExpected: plan.lamports,
        eventCount: plan.events.length,
        eventIds: plan.events.map((event) => event.id),
        source: plan.sourceKind === 'collected_allocation' ? 'collected' : 'position',
        collectedAvailable: state.unallocatedCollected,
        programId: this.program,
        ...accounted,
        checkpointStore: new FinancialDammCheckpointStore(),
      });
      if (proof.realizedNet === 0n)
        return this.store.normalizeZeroFees(
          this.networkGenesis,
          mint.toBase58(),
          eventIds,
          plan.sourceKind,
          proof
        );
      if (plan.sourceKind !== 'collected_allocation') await this.requireAccounts(mint);
      plan = await this.store.reserveRealizedFunding(
        this.networkGenesis,
        mint.toBase58(),
        eventIds,
        plan.sourceKind,
        proof
      );
    } else {
      if (plan.sourceKind !== 'collected_allocation') await this.requireAccounts(mint);
      plan = await this.store.fundingPlan(
        this.networkGenesis,
        mint.toBase58(),
        eventIds,
        plan.sourceKind
      );
    }
    if (plan.sourceKind === 'collected_allocation') {
      if (state.unallocatedCollected < plan.lamports)
        throw new Error('Verified collected reserve does not cover this allocation');
      const instruction = allocateCollectedFeesInstruction({
        programId: this.program,
        mint,
        operator: this.operator,
        fundingId: plan.fundingId,
        commitment: plan.commitment,
        events: plan.phases,
      });
      return {
        ...(await this.unsigned(instruction)),
        plan,
        vault: state.addresses.coin.toBase58(),
      };
    }
    const dbc = new DynamicBondingCurveClient(this.rpc, 'finalized');
    const config = await dbc.state.getPoolConfig(new PublicKey(state.registered.config_key));
    const pool = await dbc.state.getPool(new PublicKey(state.registered.dbc_pool));
    if (!config || !pool || !config.feeClaimer.equals(state.addresses.feeAuthority))
      throw new Error('Pool fees are not controlled by the reviewed vault authority');
    let accounts: AccountMeta[], dex: PublicKey, sourceQuoteVault: PublicKey;
    if (plan.migrated) {
      const loaded = await loadMigratedPool(this.rpc, config, mint, 'finalized');
      assertReleasedMigrationPolicy(loaded.state, mint);
      if (
        !state.migratedPool.equals(loaded.address) ||
        !(await verifiedFinancialPool(
          this.networkGenesis,
          mint.toBase58(),
          loaded.address.toBase58()
        )) ||
        state.position.equals(PublicKey.default) ||
        state.nftAccount.equals(PublicKey.default)
      )
        throw new Error('Bind the verified migrated position before claiming LP fees');
      const positionAccount = await this.rpc.getAccountInfo(state.position, 'finalized');
      if (!positionAccount?.owner.equals(CP_AMM_PROGRAM_ID))
        throw new Error('Invalid migrated position owner');
      const position = loaded.client._program.coder.accounts.decode<PositionState>(
        'position',
        positionAccount.data
      );
      const nftAccount = await this.rpc.getAccountInfo(state.nftAccount, 'finalized');
      if (!nftAccount || !position.pool.equals(loaded.address))
        throw new Error('Migrated position does not belong to this coin');
      if (
        !nftAccount.owner.equals(TOKEN_PROGRAM_ID) &&
        !nftAccount.owner.equals(TOKEN_2022_PROGRAM_ID)
      )
        throw new Error('Unreviewed migrated position NFT token program');
      const nft = unpackAccount(state.nftAccount, nftAccount, nftAccount.owner);
      if (
        !nft.owner.equals(state.addresses.feeAuthority) ||
        nft.amount !== 1n ||
        !nft.mint.equals(position.nftMint)
      )
        throw new Error('Migrated fee position is outside vault authority');
      const instruction = await loaded.client._program.methods
        .claimPositionFee()
        .accountsStrict({
          poolAuthority: deriveDammV2PoolAuthority(),
          pool: loaded.address,
          position: state.position,
          tokenAAccount: state.addresses.tokenAccount,
          tokenBAccount: state.addresses.quoteAccount,
          tokenAVault: loaded.state.tokenAVault,
          tokenBVault: loaded.state.tokenBVault,
          tokenAMint: mint,
          tokenBMint: NATIVE_MINT,
          positionNftAccount: state.nftAccount,
          signer: state.addresses.feeAuthority,
          tokenAProgram: TOKEN_PROGRAM_ID,
          tokenBProgram: TOKEN_PROGRAM_ID,
          eventAuthority: deriveDammV2EventAuthority(),
          program: CP_AMM_PROGRAM_ID,
        })
        .instruction();
      accounts = instruction.keys;
      dex = CP_AMM_PROGRAM_ID;
      sourceQuoteVault = loaded.state.tokenBVault;
    } else {
      if (
        plan.pool !== state.registered.dbc_pool ||
        !pool.poolState.baseMint.equals(mint) ||
        !pool.poolState.config.equals(new PublicKey(state.registered.config_key))
      )
        throw new Error('DBC fee source differs from the immutable launch');
      accounts = [
        meta(deriveDbcPoolAuthority()),
        meta(new PublicKey(state.registered.config_key)),
        meta(new PublicKey(state.registered.dbc_pool), true),
        meta(state.addresses.tokenAccount, true),
        meta(state.addresses.quoteAccount, true),
        meta(pool.poolState.baseVault, true),
        meta(pool.poolState.quoteVault, true),
        meta(mint),
        meta(NATIVE_MINT),
        meta(state.addresses.feeAuthority, false, true),
        meta(TOKEN_PROGRAM_ID),
        meta(TOKEN_PROGRAM_ID),
        meta(deriveDbcEventAuthority()),
        meta(DYNAMIC_BONDING_CURVE_PROGRAM_ID),
      ];
      const encoded = new BorshInstructionCoder(DynamicBondingCurveIdl as Idl).encode(
        'claim_trading_fee2',
        {
          max_amount_a: new BN(0),
          max_amount_b: new BN(plan.lamports.toString()),
          transfer_hook_accounts_info: { slices: [] },
        }
      );
      if (encoded.length !== 28) throw new Error('Unsupported DBC fee claim ABI');
      dex = DYNAMIC_BONDING_CURVE_PROGRAM_ID;
      sourceQuoteVault = pool.poolState.quoteVault;
    }
    const instruction = collectFeesInstruction({
      programId: this.program,
      mint,
      operator: this.operator,
      dexProgram: dex,
      claimAccounts: accounts,
      fundingId: plan.fundingId,
      commitment: plan.commitment,
      events: plan.phases,
      migrated: plan.migrated,
    });
    return {
      ...(await this.unsigned(instruction)),
      plan,
      vault: state.addresses.coin.toBase58(),
      unwrapAccount: state.addresses.quoteAccount.toBase58(),
      sourceQuoteVault: sourceQuoteVault.toBase58(),
    };
  }

  async prepareEpoch(mint: PublicKey, epoch: number) {
    const state = await this.state(mint),
      saved = await this.store.rewardEpoch(this.networkGenesis, mint.toBase58(), epoch);
    if (!saved || saved.status !== 'prepared' || BigInt(saved.allocated) <= 0n)
      throw new Error('A funded draft allocation is required');
    const key = epochAddress(this.program, state.addresses.coin, BigInt(epoch));
    const data = Buffer.concat([
      Buffer.from(discriminators.create_epoch),
      u64(BigInt(epoch)),
      digest32(saved.merkle_root),
      u64(BigInt(saved.snapshot_slot)),
      digest32(saved.snapshot_digest),
      u64(BigInt(saved.allocated)),
    ]);
    const instruction = new TransactionInstruction({
      programId: this.program,
      keys: [
        meta(this.operator, true, true),
        meta(state.addresses.settings),
        meta(state.addresses.coin, true),
        meta(key, true),
        meta(SystemProgram.programId),
      ],
      data,
    });
    return { ...(await this.unsigned(instruction)), epoch: epoch, allocation: saved };
  }
}
