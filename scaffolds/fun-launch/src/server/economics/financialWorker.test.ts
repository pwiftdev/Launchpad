import { describe, expect, it, vi } from 'vitest';
import { SystemProgram } from '@solana/web3.js';
import { NETWORK_GENESIS } from '../../../../../scripts/network-policy.cjs';
import { FinancialWorker } from './financialWorker';
import { type FinancialJob, type FinancialStore } from './financialStore';
import { messageDigest } from './chainEvidence';
import { fixtureWallet, transactionFixture } from './financialFixtures';

function setup() {
  const payer = fixtureWallet(),
    test = transactionFixture(
      [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: fixtureWallet().publicKey,
          lamports: 1,
        }),
      ],
      payer
    );
  test.rpc.getGenesisHash = async () => NETWORK_GENESIS.devnet;
  const order: string[] = [];
  const job = {
    id: 'job1',
    network_genesis: NETWORK_GENESIS.devnet,
    mint: fixtureWallet().publicKey.toBase58(),
    message_digest: messageDigest(test.tx.serializeMessage()),
    transaction_base64: test.tx.serialize().toString('base64'),
    signature: test.signature,
    status: 'signed',
  } as FinancialJob;
  const store = {
    attachSignedTransaction: vi.fn(async () => {
      order.push('persist-signature');
      return job;
    }),
    markSubmitted: vi.fn(async () => {
      order.push('persist-submission');
      job.status = 'submitted';
      return job;
    }),
    markUncertain: vi.fn(async () => {
      order.push('uncertain');
      job.status = 'manual_review';
    }),
    job: vi.fn(async () => job),
    recordFinalizedFailure: vi.fn(),
    settleExecution: vi.fn(),
    pendingBuyback: vi.fn(async () => null),
    balances: vi.fn(async () => [{ bucket: 'rinse_buyback', available: '100' }]),
    prepareExecution: vi.fn(async () => job),
  };
  test.rpc.sendRawTransaction = vi.fn(async () => {
    order.push('relay');
    throw new Error('response lost after send');
  });
  return { test, job, store, order };
}

describe('externally signed financial worker', () => {
  it('never relays when disabled or when configured for financial mainnet', async () => {
    const { test, store } = setup();
    const disabled = new FinancialWorker(
      test.rpc,
      store as unknown as FinancialStore,
      NETWORK_GENESIS.devnet,
      { NODE_ENV: 'test' }
    );
    await expect(
      disabled.submitSigned('job1', test.tx.serialize().toString('base64'))
    ).rejects.toThrow('disabled');
    const mainnet = new FinancialWorker(
      test.rpc,
      store as unknown as FinancialStore,
      NETWORK_GENESIS['mainnet-beta'],
      { NODE_ENV: 'test', FINANCIAL_WORKER_ENABLED: 'true', NEXT_PUBLIC_NETWORK: 'mainnet-beta' }
    );
    await expect(
      mainnet.submitSigned('job1', test.tx.serialize().toString('base64'))
    ).rejects.toThrow('mainnet');
    expect(store.attachSignedTransaction).not.toHaveBeenCalled();
    expect(test.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('commits signature and submission before relay and keeps the original uncertain transaction', async () => {
    const { test, job, store, order } = setup();
    const worker = new FinancialWorker(
      test.rpc,
      store as unknown as FinancialStore,
      NETWORK_GENESIS.devnet,
      { NODE_ENV: 'test', FINANCIAL_WORKER_ENABLED: 'true', NEXT_PUBLIC_NETWORK: 'devnet' }
    );
    const original = job.transaction_base64;
    await expect(worker.submitSigned(job.id, original)).rejects.toThrow('response lost');
    expect(order).toEqual(['persist-signature', 'persist-submission', 'relay', 'uncertain']);
    expect(job.status).toBe('manual_review');
    expect(job.transaction_base64).toBe(original);
    test.rpc.getSignatureStatuses = vi.fn(async () => ({ context: { slot: 1000 }, value: [null] }));
    test.rpc.sendRawTransaction = vi.fn(async (bytes: Buffer | Uint8Array) => {
      expect(Buffer.from(bytes).toString('base64')).toBe(original);
      return job.signature!;
    });
    await worker.rebroadcastUncertain(job.id);
    expect(store.attachSignedTransaction).toHaveBeenCalledTimes(1);
    expect(job.signature).toBe(test.signature);
  });
  it('preserves signed state without sending when the network changes during durable submission', async () => {
    const { test, job, store, order } = setup();
    test.rpc.getGenesisHash = vi
      .fn()
      .mockResolvedValueOnce(NETWORK_GENESIS.devnet)
      .mockResolvedValueOnce(NETWORK_GENESIS['mainnet-beta']);
    const worker = new FinancialWorker(
      test.rpc,
      store as unknown as FinancialStore,
      NETWORK_GENESIS.devnet,
      { NODE_ENV: 'test', FINANCIAL_WORKER_ENABLED: 'true', NEXT_PUBLIC_NETWORK: 'devnet' }
    );
    const wire = job.transaction_base64;
    await expect(worker.submitSigned(job.id, wire)).rejects.toThrow('mainnet');
    expect(order).toEqual(['persist-signature', 'persist-submission', 'uncertain']);
    expect(test.rpc.sendRawTransaction).not.toHaveBeenCalled();
    expect(job.signature).toBe(test.signature);
    expect(job.transaction_base64).toBe(wire);
    expect(job.status).toBe('manual_review');
  });
  it('rejects stale or unbounded buyback quotes before reserving any budget', async () => {
    const { test, job, store } = setup();
    const worker = new FinancialWorker(
      test.rpc,
      store as unknown as FinancialStore,
      NETWORK_GENESIS.devnet,
      { NODE_ENV: 'test' }
    );
    const quote = {
      amountIn: 100n,
      minimumTokens: 1n,
      slippageBps: 100,
      quotedAtSlot: 900,
      quotedAtTime: 3500,
      nonce: 0n,
      transactionBase64: job.transaction_base64,
      lastValidBlockHeight: 2000,
      expectation: {
        program: fixtureWallet().publicKey.toBase58(),
        accounts: [] as string[],
        dataBase64: '',
        vault: '',
        effect: 'buyback_burn' as const,
      },
    };
    const limits = {
      maximumSpendLamports: 100n,
      maximumSlippageBps: 100,
      maximumQuoteAgeSeconds: 15,
      maximumQuoteAgeSlots: 32,
    };
    await expect(
      worker.prepareBuyback(job.mint, { quote: async () => quote }, limits)
    ).rejects.toThrow('quote');
    await expect(
      worker.prepareBuyback(
        job.mint,
        {
          quote: async () => ({
            ...quote,
            quotedAtSlot: 1000,
            quotedAtTime: 3600,
            slippageBps: 101,
          }),
        },
        limits
      )
    ).rejects.toThrow('quote');
    expect(store.prepareExecution).not.toHaveBeenCalled();
  });
});
