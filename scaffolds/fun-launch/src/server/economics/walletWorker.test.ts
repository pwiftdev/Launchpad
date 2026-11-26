import { describe, it, expect, vi } from 'vitest';
import { SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { WalletWorker } from './walletWorker';
import {
  fixtureGenesis,
  fixtureWallet,
  transactionFixture,
  unsignedTransaction,
} from './financialFixtures';
import { messageDigest } from './chainEvidence';
import type { WalletStore } from './walletStore';
import type { WalletJob, WalletChainAdapter } from './walletTypes';
import { MSKD_QUOTE_LIFETIME_MS } from './walletMskdPolicy';
import { WalletRecipientUnavailable } from './walletRecipient';
function fixture() {
  const collector = fixtureWallet(),
    recipient = fixtureWallet(),
    tx = transactionFixture(
      [
        SystemProgram.transfer({
          fromPubkey: collector.publicKey,
          toPubkey: recipient.publicKey,
          lamports: 100,
        }),
      ],
      collector
    ),
    wire = Buffer.from(VersionedTransaction.deserialize(tx.tx.serialize()).serialize()).toString(
      'base64'
    );
  let job: WalletJob = {
    id: '1',
    network_genesis: fixtureGenesis,
    mint: fixtureWallet().publicKey.toBase58(),
    kind: 'creator_claim',
    intent_key: 'claim',
    bucket: 'creator',
    recipient: recipient.publicKey.toBase58(),
    epoch: null,
    lamports: '100',
    status: 'prepared',
    transaction_base64: unsignedTransaction(tx.tx),
    message_digest: messageDigest(tx.tx.serializeMessage()),
    prepared_slot: '900',
    last_valid_block_height: '1100',
    signature: null,
    finalized_slot: null,
    received_lamports: '0',
    burned_tokens: '0',
    expectations: {
      collector: collector.publicKey.toBase58(),
      pool: 'pool',
      operatingCostLamports: '5000',
    },
    details: { collector: collector.publicKey.toBase58() },
  };
  const order: string[] = [],
    store = {
      assertNoUnsettledSigned: vi.fn(async () => {}),
      job: vi.fn(async () => ({ ...job })),
      custodyRequirement: vi.fn(async () => ({
        liability: 100n,
        operating: 5000n,
        minimumSlot: 800,
      })),
      attachSigned: vi.fn(async (_id: string, bytes: string) => {
        order.push('persist');
        job = { ...job, transaction_base64: bytes, signature: tx.signature, status: 'signed' };
        return job;
      }),
      markSubmitted: vi.fn(async () => {
        order.push('submitted');
        job = { ...job, status: 'submitted' };
        return job;
      }),
      markUncertain: vi.fn(async () => {
        job = { ...job, status: 'manual_review' };
      }),
    } as unknown as WalletStore;
  Object.assign(tx.rpc, {
    getEpochInfo: vi.fn(async () => ({ absoluteSlot: 1000, blockHeight: 1000 })),
    isBlockhashValid: vi.fn(async () => ({ context: { slot: 1000 }, value: true })),
    getBalanceAndContext: vi.fn(async () => ({ context: { slot: 1000 }, value: 10000 })),
    getSignatureStatuses: vi.fn(async () => ({ context: { slot: 1000 }, value: [null] })),
    sendRawTransaction: vi.fn(async () => {
      order.push('send');
      return tx.signature;
    }),
  });
  const signer = {
      sign: vi.fn(async () => {
        order.push('sign');
        return { signedTransactionBase64: wire, signature: tx.signature };
      }),
    },
    gate = vi.fn(async () => {
      order.push('gate');
    }),
    adapter = {} as WalletChainAdapter;
  const worker = new WalletWorker(
    tx.rpc,
    store,
    fixtureGenesis,
    collector.publicKey,
    adapter,
    gate,
    signer
  );
  vi.spyOn(worker, 'coin').mockResolvedValue({
    policy_version: 'wallet-v1',
    mode: 'creator',
  } as never);
  return { worker, store, rpc: tx.rpc, signer, gate, order, getJob: () => job };
}
describe('central wallet signing and relay recovery', () => {
  it('persists exact signed bytes before send and never signs an existing attempt again', async () => {
    const f = fixture();
    await f.worker.sign('1');
    await f.worker.sign('1');
    expect(f.signer.sign).toHaveBeenCalledTimes(1);
    await f.worker.relay('1');
    expect(f.order.indexOf('persist')).toBeLessThan(f.order.indexOf('send'));
    expect(f.order.indexOf('submitted')).toBeLessThan(f.order.indexOf('send'));
    expect(f.getJob().signature).toBeTruthy();
  });
  it('lost relay response retains signature and retries identical bytes without another signer call', async () => {
    const f = fixture();
    await f.worker.sign('1');
    vi.mocked(f.rpc.sendRawTransaction).mockRejectedValueOnce(new Error('lost response'));
    await expect(f.worker.relay('1')).rejects.toThrow();
    expect(f.getJob().status).toBe('manual_review');
    const old = f.getJob().transaction_base64;
    await f.worker.relay('1');
    expect(f.getJob().transaction_base64).toBe(old);
    expect(f.signer.sign).toHaveBeenCalledTimes(1);
    expect(f.rpc.sendRawTransaction).toHaveBeenCalledTimes(2);
  });
  it('gate change after external signing preserves signed evidence and sends nothing', async () => {
    const f = fixture();
    f.gate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('closed'));
    await expect(f.worker.sign('1')).rejects.toThrow('closed');
    expect(f.getJob().status).toBe('signed');
    expect(f.getJob().signature).toBeTruthy();
    expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('liability and operating capital cannot be spent as gas', async () => {
    const f = fixture();
    vi.mocked(f.rpc.getBalanceAndContext).mockResolvedValue({
      context: { slot: 1000 },
      value: 5099,
    });
    await expect(f.worker.sign('1')).rejects.toThrow('operating capital');
    expect(f.signer.sign).not.toHaveBeenCalled();
  });
  it('stale balances and expired blockhashes fail closed without releasing reservations', async () => {
    const f = fixture();
    vi.mocked(f.rpc.getBalanceAndContext).mockResolvedValue({
      context: { slot: 799 },
      value: 100000,
    });
    await expect(f.worker.sign('1')).rejects.toThrow();
    expect(f.getJob().status).toBe('prepared');
    vi.mocked(f.rpc.isBlockhashValid).mockResolvedValue({ context: { slot: 1000 }, value: false });
    await expect(f.worker.sign('1')).rejects.toThrow('expired');
    expect(f.signer.sign).not.toHaveBeenCalled();
  });
  it('the final pre-send gate is rechecked after submission status is durable', async () => {
    const f = fixture();
    await f.worker.sign('1');
    f.gate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('network changed'));
    await expect(f.worker.relay('1')).rejects.toThrow();
    expect(f.getJob().status).toBe('manual_review');
    expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
    expect(f.getJob().transaction_base64).toBeTruthy();
  });
});

describe('MSKD conversion uses the durable wallet attempt', () => {
  function conversion() {
    const f = fixture();
    const job = f.getJob();
    Object.assign(job, { kind: 'holder_conversion', bucket: 'community', recipient: null });
    job.expectations.quoteCreatedAt = Date.now();
    vi.spyOn(f.worker, 'coin').mockResolvedValue({
      mode: 'mskd',
      policy_version: 'mskd-v1',
    } as never);
    return f;
  }
  it('keeps exact signed bytes if the worker loses its lease and after an ambiguous send', async () => {
    const f = conversion();
    f.gate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('lease lost'));
    await expect(f.worker.sign('1')).rejects.toThrow('lease lost');
    expect(f.getJob().status).toBe('signed');
    expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
    const signed = f.getJob().transaction_base64;
    vi.mocked(f.rpc.sendRawTransaction).mockRejectedValueOnce(
      new Error('ambiguous remote outcome')
    );
    await expect(f.worker.relay('1')).rejects.toThrow('ambiguous');
    expect(f.getJob().status).toBe('manual_review');
    await f.worker.relay('1');
    expect(f.getJob().transaction_base64).toBe(signed);
    expect(f.signer.sign).toHaveBeenCalledOnce();
    expect(f.rpc.sendRawTransaction).toHaveBeenNthCalledWith(2, Buffer.from(signed!, 'base64'), {
      skipPreflight: false,
      maxRetries: 0,
    });
  });

  it('keeps a signed conversion pending when its quote expires before relay', async () => {
    const f = conversion();
    await f.worker.sign('1');
    f.getJob().expectations.quoteCreatedAt = Date.now() - MSKD_QUOTE_LIFETIME_MS - 1;
    await expect(f.worker.relay('1')).rejects.toThrow('quote has expired');
    expect(f.getJob().status).toBe('signed');
    expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
});
it('another unsettled signed collector job cannot be mistaken for free operating income', async () => {
  const f = fixture();
  vi.mocked(f.store.assertNoUnsettledSigned).mockRejectedValue(
    new Error('Reconcile existing signed collector attempt')
  );
  await expect(f.worker.sign('1')).rejects.toThrow('Reconcile');
  expect(f.signer.sign).not.toHaveBeenCalled();
  expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
});
import { snapshotFixture } from './holderSnapshotFixture';
it('hourly planner skips empty income and accepts a real late snapshot after collection', async () => {
  const f = fixture(),
    snap = snapshotFixture(),
    mint = snap.mint.toBase58();
  vi.spyOn(f.worker, 'coin').mockResolvedValue({
    network_genesis: fixtureGenesis,
    mint,
    dbc_pool: fixtureWallet().publicKey.toBase58(),
    config_key: fixtureWallet().publicKey.toBase58(),
    original_deployer: fixtureWallet().publicKey.toBase58(),
    mode: 'community',
    recipient: f.worker.collector.toBase58(),
    policy_version: 'wallet-v1',
    activation_point: '1000',
    creation_signature: 'creation',
    finalized_slot: '1',
  });
  vi.spyOn(f.worker, 'index').mockResolvedValue({ complete: true, dbc: {} as never, damm: null });
  const balances = vi.fn(async () => [
      { bucket: 'community', funded: '0', reserved: '0', spent: '0', available: '0' },
    ]),
    createEpoch = vi.fn(),
    scan = vi.fn(snap.rpc.getProgramAccounts.bind(snap.rpc));
  Object.assign(f.store, {
    balances,
    pendingJobs: async (): Promise<WalletJob[]> => [],
    pendingFeeEvents: async (): Promise<never[]> => [],
    epoch: async (): Promise<null> => null,
    createEpoch,
  });
  Object.assign(f.rpc, {
    getProgramAccounts: scan,
    getAccountInfoAndContext: snap.rpc.getAccountInfoAndContext.bind(snap.rpc),
    getBlockTime: async () => 7350,
  });
  await f.worker.plan(mint);
  expect(scan).not.toHaveBeenCalled();
  expect(createEpoch).not.toHaveBeenCalled();
  balances.mockResolvedValue([
    { bucket: 'community', funded: '10', reserved: '0', spent: '0', available: '10' },
  ]);
  await f.worker.plan(mint);
  expect(createEpoch).toHaveBeenCalledOnce();
  expect(createEpoch.mock.calls[0]![0]).toMatchObject({
    epoch: 1,
    snapshot: { blockTime: 7350, slot: 1000, complete: true },
  });
});
import { WalletBuybackUnavailable } from './walletAdapter';
it('automatic planning queues the treasury only with the quarter-hour intent and fixed cap', async () => {
  const f = fixture(),
    mint = f.getJob().mint;
  vi.spyOn(f.worker, 'coin').mockResolvedValue({ mode: 'creator' } as never);
  vi.spyOn(f.worker, 'index').mockResolvedValue({ complete: true, dbc: {} as never, damm: null });
  const queueBudget = vi.fn();
  Object.assign(f.store, {
    pendingJobs: async (): Promise<WalletJob[]> => [],
    pendingFeeEvents: async (): Promise<never[]> => [],
    queueBudget,
  });
  Object.assign(f.rpc, { getBlockTime: async () => 1801 });
  await f.worker.plan(mint, undefined, 20, true);
  expect(queueBudget).toHaveBeenCalledWith({
    networkGenesis: fixtureGenesis,
    mint,
    kind: 'platform_claim',
    maximumLamports: 1_000_000_000n,
    intentKey: 'platform:quarter-hour:2',
  });
  queueBudget.mockClear();
  await f.worker.plan(mint);
  expect(queueBudget).not.toHaveBeenCalled();
});
it('does not sign an existing prepared buyback below the new minimum', async () => {
  const f = fixture();
  Object.assign(f.getJob(), { kind: 'buyback', lamports: '24999999' });
  await expect(f.worker.sign('1')).rejects.toThrow('0.025 SOL minimum');
  expect(f.signer.sign).not.toHaveBeenCalled();
});
it('a zero-output buyback stays queued while the same coin payout is prepared', async () => {
  const f = fixture(),
    buyback = { ...f.getJob(), id: 'dust', kind: 'buyback' as const, status: 'queued' as const },
    payout = f.getJob();
  vi.spyOn(f.worker, 'coin').mockResolvedValue({ mode: 'creator' } as never);
  vi.spyOn(f.worker, 'index').mockResolvedValue({ complete: true, dbc: {} as never, damm: null });
  Object.assign(f.store, {
    pendingJobs: async () => [buyback, payout],
    pendingFeeEvents: async (): Promise<never[]> => [],
  });
  const prepare = vi
    .spyOn(f.worker, 'prepare')
    .mockRejectedValueOnce(new WalletBuybackUnavailable())
    .mockResolvedValueOnce(payout);
  const result = await f.worker.plan(payout.mint);
  expect(prepare.mock.calls.map((c) => c[0])).toEqual(['dust', '1']);
  expect(result.jobs.map((j) => j.status)).toEqual(['queued', 'prepared']);
  expect(f.signer.sign).not.toHaveBeenCalled();
});
it('prepares collection even when a queued payout cannot meet recipient rent', async () => {
  const f = fixture();
  const blocked = {
    ...f.getJob(),
    id: 'treasury',
    kind: 'platform_claim',
    status: 'queued',
  } as const;
  const collection = { ...f.getJob(), kind: 'collect' } as const;
  vi.spyOn(f.worker, 'coin').mockResolvedValue({ mode: 'dev' } as never);
  vi.spyOn(f.worker, 'index').mockResolvedValue({ complete: true, dbc: {} as never, damm: null });
  Object.assign(f.store, { pendingJobs: async () => [blocked, collection] });
  const prepare = vi
    .spyOn(f.worker, 'prepare')
    .mockRejectedValueOnce(new WalletRecipientUnavailable())
    .mockResolvedValueOnce(collection);
  const result = await f.worker.plan(collection.mint);
  expect(prepare.mock.calls).toEqual([[blocked.id], [collection.id]]);
  expect(result.jobs).toEqual([blocked, collection]);
});
