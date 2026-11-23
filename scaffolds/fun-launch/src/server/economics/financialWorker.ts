import { Connection } from '@solana/web3.js';
import { expectedNetworkGenesis, NETWORK_GENESIS } from '../../../../../scripts/network-policy.cjs';
import { FinalizedVerifier, validateSignedTransaction, type FinalizedClock } from './chainEvidence';
import { FinancialStore, type FinancialJob, type PreparedExecution } from './financialStore';

export type BuybackLimits = {
  maximumSpendLamports: bigint;
  maximumSlippageBps: number;
  maximumQuoteAgeSeconds: number;
  maximumQuoteAgeSlots: number;
};
export type BuybackQuote = {
  amountIn: bigint;
  minimumTokens: bigint;
  slippageBps: number;
  quotedAtSlot: number;
  quotedAtTime: number;
  nonce: bigint;
  transactionBase64: string;
  lastValidBlockHeight: number;
  expectation: PreparedExecution['expectation'];
};
export type BuybackAdapter = {
  quote(input: {
    networkGenesis: string;
    mint: string;
    amount: bigint;
    clock: FinalizedClock;
    maximumSlippageBps: number;
  }): Promise<BuybackQuote>;
};

export async function assertFinancialRelay(
  rpc: Connection,
  genesis: string,
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (environment.FINANCIAL_WORKER_ENABLED !== 'true')
    throw new Error('Financial worker relay is disabled');
  const expected = expectedNetworkGenesis(environment);
  if (
    expected === NETWORK_GENESIS['mainnet-beta'] ||
    environment.NEXT_PUBLIC_NETWORK === 'mainnet-beta' ||
    expected !== genesis ||
    (await rpc.getGenesisHash()) !== expected
  )
    throw new Error('Financial mainnet relay is not released');
}

/** Durable state is committed before relay. This worker never loads a private key or signs. */
export class FinancialWorker {
  private readonly verifier: FinalizedVerifier;
  constructor(
    private readonly rpc: Connection,
    private readonly store: FinancialStore,
    private readonly networkGenesis: string,
    private readonly environment: NodeJS.ProcessEnv = process.env
  ) {
    this.verifier = new FinalizedVerifier(rpc, networkGenesis);
  }

  async prepareBuyback(
    mint: string,
    adapter: BuybackAdapter,
    limits: BuybackLimits
  ): Promise<FinancialJob | null> {
    if (
      limits.maximumSpendLamports <= 0n ||
      !Number.isSafeInteger(limits.maximumSlippageBps) ||
      limits.maximumSlippageBps < 0 ||
      limits.maximumSlippageBps > 100 ||
      !Number.isSafeInteger(limits.maximumQuoteAgeSeconds) ||
      limits.maximumQuoteAgeSeconds < 1 ||
      limits.maximumQuoteAgeSeconds > 30 ||
      !Number.isSafeInteger(limits.maximumQuoteAgeSlots) ||
      limits.maximumQuoteAgeSlots < 1 ||
      limits.maximumQuoteAgeSlots > 64
    )
      throw new Error('Explicit bounded buyback limits are required');
    const pending = await this.store.pendingBuyback(this.networkGenesis, mint);
    if (pending) return pending;
    const balance = (await this.store.balances(this.networkGenesis, mint)).find(
      (item) => item.bucket === 'rinse_buyback'
    );
    const available = BigInt(balance?.available ?? '0');
    if (available <= 0n) return null;
    const amount =
      available < limits.maximumSpendLamports ? available : limits.maximumSpendLamports;
    const clock = await this.verifier.clock();
    const quote = await adapter.quote({
      networkGenesis: this.networkGenesis,
      mint,
      amount,
      clock,
      maximumSlippageBps: limits.maximumSlippageBps,
    });
    const current = await this.verifier.clock();
    if (
      quote.amountIn !== amount ||
      quote.minimumTokens <= 0n ||
      !Number.isSafeInteger(quote.slippageBps) ||
      quote.slippageBps < 0 ||
      quote.slippageBps > limits.maximumSlippageBps ||
      !Number.isSafeInteger(quote.quotedAtTime) ||
      quote.quotedAtTime > current.blockTime ||
      current.blockTime - quote.quotedAtTime > limits.maximumQuoteAgeSeconds ||
      !Number.isSafeInteger(quote.quotedAtSlot) ||
      quote.quotedAtSlot > current.slot ||
      current.slot - quote.quotedAtSlot > limits.maximumQuoteAgeSlots ||
      quote.expectation.effect !== 'buyback_burn'
    )
      throw new Error('Buyback quote exceeds approved age, slippage, amount or execution bounds');
    return this.store.prepareExecution({
      networkGenesis: this.networkGenesis,
      mint,
      intentKey: `buyback:${quote.nonce}:${current.slot}`,
      kind: 'buyback',
      lamports: amount,
      clock: current,
      transactionBase64: quote.transactionBase64,
      lastValidBlockHeight: quote.lastValidBlockHeight,
      expectation: quote.expectation,
    });
  }

  private async allowRelay(): Promise<void> {
    return assertFinancialRelay(this.rpc, this.networkGenesis, this.environment);
  }

  async submitSigned(jobId: string, base64: string): Promise<FinancialJob> {
    await this.allowRelay();
    const signed = await this.store.attachSignedTransaction(jobId, base64);
    const bytes = validateSignedTransaction(signed.transaction_base64, signed.message_digest).bytes;
    // Commit before sending: a timeout after send must never generate a replacement spend.
    const submitted = await this.store.markSubmitted(jobId);
    try {
      // Signing/SQL waits must not bridge a network switch before broadcast.
      await this.allowRelay();
      const signature = await this.rpc.sendRawTransaction(bytes, {
        skipPreflight: false,
        maxRetries: 2,
      });
      if (signature !== submitted.signature)
        throw new Error('Relay returned another transaction identity');
    } catch (error) {
      await this.store.markUncertain(jobId);
      throw error;
    }
    return submitted;
  }

  async reconcile(jobId: string): Promise<FinancialJob> {
    const job = await this.store.job(jobId);
    if (!job || job.network_genesis !== this.networkGenesis)
      throw new Error('Execution does not belong to this worker network');
    if (!job.signature || ['finalized', 'failed'].includes(job.status)) return job;
    const statuses = await this.rpc.getSignatureStatuses([job.signature], {
      searchTransactionHistory: true,
    });
    const status = statuses.value[0];
    if (!status || status.confirmationStatus !== 'finalized') return job;
    if (status.err)
      return this.store.recordFinalizedFailure(
        jobId,
        await this.verifier.failure(job.signature, job.message_digest)
      );
    return this.store.settleExecution(
      jobId,
      await this.verifier.transaction(job.signature, job.message_digest)
    );
  }

  /** Recovery can relay identical bytes/signature only; no new nonce, quote or blockhash. */
  async rebroadcastUncertain(jobId: string): Promise<FinancialJob> {
    await this.allowRelay();
    const job = await this.reconcile(jobId);
    if (['finalized', 'failed'].includes(job.status)) return job;
    if (!job.signature || !['submitted', 'manual_review'].includes(job.status))
      throw new Error('No uncertain signed execution exists');
    const bytes = validateSignedTransaction(job.transaction_base64, job.message_digest).bytes;
    const returned = await this.rpc.sendRawTransaction(bytes, {
      skipPreflight: false,
      maxRetries: 2,
    });
    if (returned !== job.signature)
      throw new Error('Recovery relay changed the transaction identity');
    return job;
  }
}
