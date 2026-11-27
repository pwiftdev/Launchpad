import { isWalletPolicy } from '@/lib/launchModes';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  DynamicBondingCurveClient,
  deriveDbcPoolAuthority,
  deriveDammV2PoolAuthority,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import type { RegisteredCoin } from '../launchRegistry';
import { registeredCoin } from '../launchRegistry';
import { discoverMigrationBoundary, migrationHistoryBoundary } from '../migrationRegistry';
import { migratedPoolAddress } from '../damm';
import { FinalizedVerifier, validateSignedTransaction } from './chainEvidence';
import { FinalizedFeeIndexer } from './finalizedIndexer';
import { collectHolderSnapshot } from './holderSnapshot';
import { configuredCompanyWallets } from '../launchConfig';
import { mskdConversionPool, mskdPayoutMint, requireFreshMskdQuote } from './walletMskdPolicy';
import {
  hasBatchedHolderRewards,
  isCashbackMode,
  isMaskedMode,
  isMskdMode,
} from '@/lib/launchModes';
import { MINIMUM_HOLDER_PAYOUT_LAMPORTS } from '@/lib/rewards';
import { assertPayoutTokenBacking } from './walletTokenCustody';
import { MASKED_SAMPLE_SECONDS, WalletStore } from './walletStore';
import { verifyWalletRecovery } from './walletRecovery';
import { WalletCollectionUnavailable, WalletBuybackUnavailable } from './walletAdapter';
import { WalletRecipientUnavailable } from './walletRecipient';
import {
  MINIMUM_BUYBACK_LAMPORTS,
  MAXIMUM_AUTOMATIC_TREASURY_LAMPORTS,
  treasuryIntent,
  WalletOperatingUnavailable,
} from './walletPolicy';
import type { WalletChainAdapter, WalletSigner, WalletJob } from './walletTypes';
export class WalletMessageExpired extends Error {
  override readonly name = 'WalletMessageExpired';
  constructor() {
    super('Wallet message expired; positive recovery is required');
  }
}

/** One finite private-worker operation. Signature bytes are durable before every relay. */
export class WalletWorker {
  constructor(
    readonly rpc: Connection,
    readonly store: WalletStore,
    readonly genesis: string,
    readonly collector: PublicKey,
    readonly adapter: WalletChainAdapter,
    readonly gate: () => Promise<unknown>,
    readonly signer?: WalletSigner
  ) {}
  async coin(mint: string): Promise<RegisteredCoin> {
    const coin = await registeredCoin(this.genesis, mint);
    if (!coin || !isWalletPolicy(coin.policy_version))
      throw new Error('Reviewed wallet-v1 coin required');
    return coin;
  }
  async index(mint: string) {
    await this.gate();
    const coin = await this.coin(mint),
      source = {
        networkGenesis: this.genesis,
        mint,
        pool: coin.dbc_pool,
        configKey: coin.config_key,
        activationPoint: Number(coin.activation_point),
        mode: coin.mode,
        creatorShareBps: coin.creator_share_bps,
      },
      indexer = new FinalizedFeeIndexer(this.rpc, this.store);
    const dbc = await indexer.runPool(source, {
      creationSignature: coin.creation_signature,
      route: 'dbc',
    });
    if (!dbc.complete || dbc.paused) return { complete: false, dbc, damm: null };
    const actual = await new DynamicBondingCurveClient(this.rpc, 'finalized').state.getPool(
      new PublicKey(coin.dbc_pool)
    );
    if (!actual) throw new Error('Canonical DBC state unavailable');
    if (Number(actual.poolState.isMigrated) !== 1) return { complete: true, dbc, damm: null };
    let boundary = await migrationHistoryBoundary(this.genesis, mint);
    if (!boundary) {
      await discoverMigrationBoundary(this.genesis, mint);
      boundary = await migrationHistoryBoundary(this.genesis, mint);
    }
    const config = await new DynamicBondingCurveClient(this.rpc, 'finalized').state.getPoolConfig(
      new PublicKey(coin.config_key)
    );
    if (!config) throw new Error('Reviewed DBC config unavailable');
    const pool = migratedPoolAddress(config, new PublicKey(mint));
    const damm = await indexer.runPool(
      { ...source, pool: pool.toBase58() },
      { creationSignature: boundary?.signature ?? null, route: 'damm-v2' }
    );
    return { complete: damm.complete && !damm.paused, dbc, damm };
  }
  async reconcile(id: string): Promise<'finalized' | 'failed' | 'pending'> {
    const job = await this.required(id);
    if (job.status === 'finalized' || job.status === 'failed') return job.status;
    if (!job.signature || !job.message_digest) return 'pending';
    const statuses = await this.rpc.getSignatureStatuses([job.signature], {
        searchTransactionHistory: true,
      }),
      status = statuses.value[0];
    if (status?.confirmationStatus !== 'finalized') return 'pending';
    const verifier = new FinalizedVerifier(this.rpc, this.genesis);
    if (status.err) {
      const failure = await verifier.failure(job.signature, job.message_digest);
      await this.gate();
      await this.store.recordFailure(id, failure);
      return 'failed';
    }
    const evidence = await verifier.transaction(job.signature, job.message_digest);
    if (job.kind === 'collect' && !(await this.index(job.mint)).complete) return 'pending';
    const effect = await this.adapter.verifyFinalized(job, evidence);
    await this.gate();
    await this.store.settle(id, effect);
    return 'finalized';
  }
  async required(id: string) {
    const job = await this.store.job(id);
    if (
      !job ||
      job.network_genesis !== this.genesis ||
      job.details.collector !== this.collector.toBase58()
    )
      throw new Error('Wallet job belongs to another operator');
    return job;
  }
  async prepare(id: string) {
    await this.gate();
    let job = await this.required(id);
    if (job.status === 'prepared') {
      try {
        await this.unexpired(job);
        return job;
      } catch (error) {
        if (!(error instanceof WalletMessageExpired)) throw error;
        job = await this.recover(id);
      }
    }
    if (job.status !== 'queued') return job;
    const coin = await this.coin(job.mint);
    let prepared;
    if (job.kind === 'collect') {
      const events = await this.store.collectionEvents(job);
      prepared = await this.adapter.prepareCollection({
        coin,
        events,
        maximumQuoteLamports: events.reduce((sum, row) => sum + row.net, 0n),
      });
    } else if (job.kind === 'buyback') {
      if (BigInt(job.lamports) < MINIMUM_BUYBACK_LAMPORTS) throw new WalletBuybackUnavailable();
      prepared = await this.adapter.prepareBuyback({
        coin,
        maximumSpendLamports: BigInt(job.lamports),
      });
    } else if (job.kind === 'holder_conversion') {
      if (!this.adapter.prepareHolderConversion)
        throw new Error('MSKD conversion adapter is unavailable');
      prepared = await this.adapter.prepareHolderConversion(job);
    } else if (job.kind === 'setup') prepared = await this.adapter.prepareSetup({ coin });
    else prepared = await this.adapter.preparePayout(job);
    await this.gate();
    job = await this.store.prepareJob(id, prepared);
    return job;
  }
  async recover(id: string) {
    await this.gate();
    const job = await this.required(id);
    if (job.signature && (await this.reconcile(id)) !== 'pending') return this.required(id);
    const proof = await verifyWalletRecovery(this.rpc, job);
    await this.gate();
    return this.store.renew(id, proof);
  }
  async plan(mint: string, maximumBuyback?: bigint, maximumJobs = 20, automaticTreasury = false) {
    await this.gate();
    const coin = await this.coin(mint),
      index = await this.index(mint);
    if (!index.complete) return { status: 'index_paused', jobs: [] as WalletJob[] };
    let pending = await this.store.pendingJobs(this.genesis, mint, 100);
    if (!pending.some((job) => job.kind === 'collect')) {
      const events = await this.store.pendingFeeEvents(this.genesis, mint);
      if (events.length) {
        const pool = events[0]!.pool;
        const selected = events.filter((row) => row.pool === pool);
        let affordable = true;
        if (coin.policy_version === 'bond-v1') {
          try {
            const net = selected.reduce((sum, row) => sum + row.net, 0n);
            const preview = await this.adapter.prepareCollection({
              coin,
              events: selected,
              maximumQuoteLamports: net,
            });
            affordable = await this.store.collectionAffordable(
              this.genesis,
              mint,
              pool,
              net,
              BigInt(String(preview.expectations.operatingCostLamports))
            );
          } catch (error) {
            if (!(error instanceof WalletCollectionUnavailable)) throw error;
            affordable = false;
          }
        }
        await this.gate();
        if (affordable) await this.store.queueCollection(this.genesis, mint, selected);
      }
    }
    if (maximumBuyback && maximumBuyback > 0n) {
      await this.gate();
      await this.store.queueBudget({
        networkGenesis: this.genesis,
        mint,
        kind: 'buyback',
        maximumLamports: maximumBuyback,
        minimumLamports: MINIMUM_BUYBACK_LAMPORTS,
      });
    }
    if (automaticTreasury) {
      const clock = await new FinalizedVerifier(this.rpc, this.genesis).clock();
      await this.gate();
      await this.store.queueBudget({
        networkGenesis: this.genesis,
        mint,
        kind: 'platform_claim',
        maximumLamports: MAXIMUM_AUTOMATIC_TREASURY_LAMPORTS,
        intentKey: treasuryIntent(clock.blockTime),
      });
    }
    if (
      coin.mode === 'community' ||
      isCashbackMode(coin.mode) ||
      (isMskdMode(coin.mode) &&
        mskdPayoutMint(this.genesis) &&
        mskdConversionPool() &&
        !pending.some((job) => job.kind === 'holder_conversion'))
    )
      await this.allocateHolderIncome(coin);
    if (isMaskedMode(coin.mode)) await this.sampleMaskedHolders(coin);
    pending = await this.store.pendingJobs(this.genesis, mint, maximumJobs);
    const jobs: WalletJob[] = [];
    for (const job of pending) {
      try {
        jobs.push(await this.prepare(job.id));
      } catch (error) {
        if (
          !(error instanceof WalletCollectionUnavailable) &&
          !(error instanceof WalletBuybackUnavailable) &&
          !(error instanceof WalletRecipientUnavailable) &&
          !(error instanceof WalletOperatingUnavailable)
        )
          throw error;
        jobs.push(job);
      }
    }
    return { status: 'planned', jobs };
  }
  /**
   * Masked holder income follows time-weighted balances: one verified full snapshot per
   * five-minute window while the coin has holder income waiting, and in the first window of each
   * hour the previous hour is averaged and allocated.
   */
  private async sampleMaskedHolders(coin: RegisteredCoin) {
    const community = (await this.store.balances(this.genesis, coin.mint)).find(
      (balance) => balance.bucket === 'community'
    );
    if (!community || BigInt(community.available) < MINIMUM_HOLDER_PAYOUT_LAMPORTS) return;
    const clock = await new FinalizedVerifier(this.rpc, this.genesis).clock();
    const window = Math.floor(clock.blockTime / MASKED_SAMPLE_SECONDS);
    if (!(await this.store.hasMaskedSample(this.genesis, coin.mint, window))) {
      const { collector, treasury } = configuredCompanyWallets(this.genesis);
      const snapshot = await collectHolderSnapshot(this.rpc, {
        networkGenesis: this.genesis,
        mint: coin.mint,
        excludedOwners: new Set([
          PublicKey.default.toBase58(),
          deriveDbcPoolAuthority().toBase58(),
          deriveDammV2PoolAuthority().toBase58(),
          collector.toBase58(),
          treasury.toBase58(),
          '1nc1nerator11111111111111111111111111111111',
        ]),
        excludedTokenAccounts: new Set([
          getAssociatedTokenAddressSync(new PublicKey(coin.mint), this.collector).toBase58(),
        ]),
      });
      await this.gate();
      // A slow scan can land in the next window; it is stored under the window it observed.
      await this.store.recordMaskedSample(snapshot);
    }
    if (clock.blockTime % 3600 < MASKED_SAMPLE_SECONDS) {
      await this.gate();
      await this.store.createMaskedEpoch(
        this.genesis,
        coin.mint,
        Math.floor(clock.blockTime / 3600) - 1
      );
    }
  }
  private async allocateHolderIncome(coin: RegisteredCoin) {
    const community = (await this.store.balances(this.genesis, coin.mint)).find(
      (balance) => balance.bucket === 'community'
    );
    if (!community || BigInt(community.available) <= 0n) return;
    const clock = await new FinalizedVerifier(this.rpc, this.genesis).clock();
    const epoch = Math.floor(clock.blockTime / 3600) - 1;
    const hourly = hasBatchedHolderRewards(coin.mode);
    if (
      epoch < 0 ||
      (hourly && clock.blockTime % 3600 >= 60) ||
      (await this.store.epoch(this.genesis, coin.mint, epoch))
    )
      return;
    const excludedOwners = new Set([
      PublicKey.default.toBase58(),
      deriveDbcPoolAuthority().toBase58(),
      deriveDammV2PoolAuthority().toBase58(),
    ]);
    if (hourly) {
      const { collector, treasury } = configuredCompanyWallets(this.genesis);
      for (const owner of [
        collector.toBase58(),
        treasury.toBase58(),
        '1nc1nerator11111111111111111111111111111111',
      ])
        excludedOwners.add(owner);
    }
    const snapshot = await collectHolderSnapshot(this.rpc, {
      networkGenesis: this.genesis,
      mint: coin.mint,
      excludedOwners,
      excludedTokenAccounts: new Set([
        getAssociatedTokenAddressSync(new PublicKey(coin.mint), this.collector).toBase58(),
      ]),
    });
    if (
      hourly &&
      (Math.floor(snapshot.blockTime / 3600) - 1 !== epoch || snapshot.blockTime % 3600 >= 60)
    )
      return;
    await this.gate();
    if (isMskdMode(coin.mode)) {
      await this.store.queueMskdConversion(snapshot);
      return;
    }
    await this.store.createEpoch({
      networkGenesis: this.genesis,
      mint: coin.mint,
      epoch: Math.floor(snapshot.blockTime / 3600) - 1,
      snapshot,
    });
  }
  private async solvent(job: WalletJob) {
    const coin = await this.coin(job.mint);
    if (coin.policy_version === 'bond-v1') await this.store.assertOperatingFunding(job);
    await assertPayoutTokenBacking(this.rpc, this.store, this.collector, job, coin);
    const requirement = await this.store.custodyRequirement(
        this.genesis,
        this.collector.toBase58()
      ),
      balance = await this.rpc.getBalanceAndContext(this.collector, {
        commitment: 'finalized',
        minContextSlot: requirement.minimumSlot,
      });
    if (
      !Number.isSafeInteger(balance.value) ||
      balance.context.slot < requirement.minimumSlot ||
      BigInt(balance.value) < requirement.liability + requirement.operating
    )
      throw new Error('Collector operating capital cannot spend reserved income');
  }
  private async unexpired(job: WalletJob) {
    if (!job.transaction_base64 || job.last_valid_block_height === null)
      throw new Error('Prepared wallet transaction required');
    const { VersionedTransaction } = await import('@solana/web3.js');
    const tx = VersionedTransaction.deserialize(Buffer.from(job.transaction_base64, 'base64'));
    const bank = await this.rpc.getEpochInfo({
        commitment: 'finalized',
        minContextSlot: Number(job.prepared_slot),
      }),
      hash = await this.rpc.isBlockhashValid(tx.message.recentBlockhash, {
        commitment: 'confirmed',
        minContextSlot: Math.max(Number(job.prepared_slot), bank.absoluteSlot),
      });
    if (
      !Number.isSafeInteger(bank.absoluteSlot) ||
      bank.absoluteSlot < Number(job.prepared_slot) ||
      !Number.isSafeInteger(bank.blockHeight) ||
      bank.blockHeight! > Number(job.last_valid_block_height) ||
      !hash.value ||
      !Number.isSafeInteger(hash.context.slot) ||
      hash.context.slot < bank.absoluteSlot
    )
      throw new WalletMessageExpired();
  }
  async sign(id: string) {
    if (!this.signer) throw new Error('External wallet signer required');
    let job = await this.required(id);
    if (job.signature) return job;
    if (job.status !== 'prepared') throw new Error('Prepared wallet job required');
    if (job.kind === 'buyback' && BigInt(job.lamports) < MINIMUM_BUYBACK_LAMPORTS)
      throw new Error('Buyback is below the 0.025 SOL minimum');
    await this.gate();
    await this.store.assertNoUnsettledSigned(this.genesis, this.collector.toBase58(), id);
    await this.unexpired(job);
    await this.solvent(job);
    if (job.kind === 'holder_conversion') requireFreshMskdQuote(job.expectations.quoteCreatedAt);
    const signed = await this.signer.sign(job),
      checked = validateSignedTransaction(signed.signedTransactionBase64, job.message_digest!);
    if (checked.signature !== signed.signature)
      throw new Error('External signature identity differs');
    job = await this.store.attachSigned(id, signed.signedTransactionBase64);
    await this.store.assertNoUnsettledSigned(this.genesis, this.collector.toBase58(), id);
    await this.gate();
    await this.solvent(job);
    return job;
  }
  async relay(id: string) {
    let job = await this.required(id);
    if (!job.signature || !job.transaction_base64)
      throw new Error('Durable signed message required');
    if ((await this.reconcile(id)) !== 'pending') return this.required(id);
    await this.gate();
    await this.unexpired(job);
    await this.solvent(job);
    if (job.kind === 'holder_conversion') requireFreshMskdQuote(job.expectations.quoteCreatedAt);
    job = await this.store.markSubmitted(id);
    try {
      await this.gate();
      await this.solvent(job);
      await this.gate();
      if (job.kind === 'holder_conversion') requireFreshMskdQuote(job.expectations.quoteCreatedAt);
      const signature = await this.rpc.sendRawTransaction(
        Buffer.from(job.transaction_base64!, 'base64'),
        { skipPreflight: false, maxRetries: 0 }
      );
      if (signature !== job.signature) throw new Error('RPC signature differs');
      return job;
    } catch (error) {
      await this.store.markUncertain(id);
      throw error;
    }
  }
}
