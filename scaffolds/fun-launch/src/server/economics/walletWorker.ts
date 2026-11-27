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
import {
  isFreshMskdQuote,
  mskdConversionPool,
  mskdPayoutMint,
  requireFreshMskdQuote,
} from './walletMskdPolicy';
import {
  hasBatchedHolderRewards,
  isCashbackMode,
  isMaskedMode,
  isMskdMode,
} from '@/lib/launchModes';
import { MINIMUM_HOLDER_PAYOUT_LAMPORTS } from '@/lib/rewards';
import { mskdBuybackMint } from './maskedBuyback';
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

/** A swap job's price quote expires; it must be signed and sent while still fresh. */
const quoted = (job: WalletJob) => job.kind === 'holder_conversion' || job.kind === 'wxmr_claim';
const needsNewQuote = (job: WalletJob) =>
  quoted(job) && !isFreshMskdQuote(job.expectations.quoteCreatedAt);
export class WalletWxmrUnavailable extends Error {
  override readonly name = 'WalletWxmrUnavailable';
  constructor(cause: unknown) {
    super(
      `wXMR payment cannot be quoted now: ${cause instanceof Error ? cause.message : 'unknown'}`
    );
  }
}

/** One finite private-worker operation. Signature bytes are durable before every relay. */
export class WalletWorker {
  private readonly checkedHolderEpochs = new Map<string, number>();

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
    const replacedDigest =
      job.status === 'prepared' && !job.signature && needsNewQuote(job) ? job.message_digest : null;
    if (job.status === 'prepared' && !replacedDigest) {
      try {
        await this.unexpired(job);
        return job;
      } catch (error) {
        if (!(error instanceof WalletMessageExpired)) throw error;
        job = await this.recover(id);
      }
    }
    if (job.status !== 'queued' && !replacedDigest) return job;
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
    } else if (job.kind === 'wxmr_claim') {
      if (!this.adapter.prepareWxmrClaim) throw new Error('wXMR payout adapter is unavailable');
      try {
        prepared = await this.adapter.prepareWxmrClaim(job);
      } catch (error) {
        // Thin liquidity or a moved price: the payment waits and is quoted again next pass.
        throw new WalletWxmrUnavailable(error);
      }
    } else if (job.kind === 'setup') prepared = await this.adapter.prepareSetup({ coin });
    else prepared = await this.adapter.preparePayout(job);
    await this.gate();
    return this.store.prepareJob(id, prepared, replacedDigest);
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
    if (isMaskedMode(coin.mode)) {
      const balances = await this.store.balances(this.genesis, coin.mint);
      await this.sampleMaskedHolders(
        coin,
        BigInt(balances.find((row) => row.bucket === 'community')?.available ?? '0')
      );
      await this.fundMskdBuyback(
        coin,
        BigInt(balances.find((row) => row.bucket === 'mskd_buyback')?.available ?? '0')
      );
    }
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
          !(error instanceof WalletOperatingUnavailable) &&
          !(error instanceof WalletWxmrUnavailable)
        )
          throw error;
        jobs.push(job);
      }
    }
    return { status: 'planned', jobs };
  }
  /** Queues the next payment of each open Masked wXMR claim, once a wXMR market is configured. */
  async queueWxmrPayments() {
    const asset = mskdPayoutMint(this.genesis),
      market = mskdConversionPool();
    if (!asset || !market) return;
    await this.gate();
    await this.store.queueMaskedWxmrPayments({
      network: this.genesis,
      collector: this.collector.toBase58(),
      assetMint: asset.toBase58(),
      market: market.toBase58(),
      alert: (alert) => console.error(JSON.stringify({ event: 'masked_wxmr_alert', ...alert })),
    });
  }
  /** Moves this Masked coin's $MSKD share onto the official $MSKD coin's buyback budget. */
  private async fundMskdBuyback(coin: RegisteredCoin, available: bigint) {
    if (available < MINIMUM_HOLDER_PAYOUT_LAMPORTS) return;
    const target = mskdBuybackMint(this.genesis);
    if (!target || target === coin.mint) return;
    await this.gate();
    await this.store.transferMskdBuyback(this.genesis, coin.mint, target);
  }
  private async sampleMaskedHolders(coin: RegisteredCoin, available: bigint) {
    if (available < MINIMUM_HOLDER_PAYOUT_LAMPORTS) return;
    const clock = await new FinalizedVerifier(this.rpc, this.genesis).clock();
    let sampledAt = clock.blockTime;
    const window = Math.floor(sampledAt / MASKED_SAMPLE_SECONDS);
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
      sampledAt = Math.max(sampledAt, snapshot.blockTime);
    }
    const epoch = Math.floor(sampledAt / 3600) - 1;
    if (epoch <= (this.checkedHolderEpochs.get(coin.mint) ?? -1)) return;
    await this.gate();
    const result = await this.store.createMaskedEpoch(this.genesis, coin.mint, epoch);
    if (result.status === 'no_income') return;
    if (result.status === 'insufficient_samples' && sampledAt % 3600 < MASKED_SAMPLE_SECONDS)
      return;
    this.checkedHolderEpochs.set(coin.mint, epoch);
    if (result.status === 'insufficient_samples')
      console.error(
        JSON.stringify({
          event: 'masked_epoch_alert',
          level: 'warning',
          mint: coin.mint,
          epoch,
          samples: result.samples,
          message: 'Too few holder samples; this hour’s holder income rolls into the next hour',
        })
      );
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
    if (job.status === 'prepared' && !job.signature && needsNewQuote(job))
      job = await this.prepare(id);
    if (job.signature) return job;
    if (job.status !== 'prepared') throw new Error('Prepared wallet job required');
    if (job.kind === 'buyback' && BigInt(job.lamports) < MINIMUM_BUYBACK_LAMPORTS)
      throw new Error('Buyback is below the 0.025 SOL minimum');
    await this.gate();
    await this.store.assertNoUnsettledSigned(this.genesis, this.collector.toBase58(), id);
    await this.unexpired(job);
    await this.solvent(job);
    if (quoted(job)) requireFreshMskdQuote(job.expectations.quoteCreatedAt);
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
    if (quoted(job)) requireFreshMskdQuote(job.expectations.quoteCreatedAt);
    job = await this.store.markSubmitted(id);
    try {
      await this.gate();
      await this.solvent(job);
      await this.gate();
      if (quoted(job)) requireFreshMskdQuote(job.expectations.quoteCreatedAt);
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
