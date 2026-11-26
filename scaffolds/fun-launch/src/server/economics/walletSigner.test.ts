import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type Connection,
} from '@solana/web3.js';
import {
  fixtureGenesis,
  fixtureWallet,
  transactionFixture,
  unsignedTransaction,
} from './financialFixtures';
import { messageDigest } from './chainEvidence';
import { WALLET_MEMO_PROGRAM } from './walletEvidence';
import { validateWalletSignJob, WalletExternalSigner, WALLET_SIGN_PROTOCOL } from './walletSigner';
import { walletSignerConfig } from './walletSignerConfig';
import type { WalletJob } from './walletTypes';
import type { WalletStore } from './walletStore';
import devCompany from '../../../../../docs/mskd-mainnet-dev-wallets.public.json';
const stubs = vi.hoisted(() => ({
  gate: vi.fn(),
  coin: vi.fn(),
  prepare: vi.fn(),
  exchange: vi.fn(),
}));
vi.mock('./externalSigner', () => ({ signerExchange: stubs.exchange }));
vi.mock('./walletGate', () => ({ assertWalletExecutionGate: stubs.gate }));
vi.mock('../launchRegistry', () => ({ registeredCoin: stubs.coin }));
vi.mock('./walletAdapter', () => ({
  MeteoraWalletAdapter: class {
    preparePayout = stubs.prepare;
  },
}));
const limits = {
  maximumBuybackLamports: '1000000',
  maximumPayoutLamports: '1000000',
  maximumOperatingCostLamports: '100000',
};
function fixture() {
  const collector = fixtureWallet(),
    recipient = fixtureWallet().publicKey,
    mint = fixtureWallet().publicKey.toBase58();
  const t = transactionFixture(
    [
      SystemProgram.transfer({
        fromPubkey: collector.publicKey,
        toPubkey: recipient,
        lamports: 800000,
      }),
      new TransactionInstruction({
        programId: WALLET_MEMO_PROGRAM,
        keys: [],
        data: Buffer.from('RINSED:00000000-0000-4000-8000-000000000000'),
      }),
    ],
    collector
  );
  const job: WalletJob = {
    id: '00000000-0000-4000-8000-000000000000',
    network_genesis: fixtureGenesis,
    mint,
    kind: 'creator_claim',
    intent_key: 'test',
    bucket: 'creator',
    recipient: recipient.toBase58(),
    epoch: null,
    lamports: '800000',
    status: 'prepared',
    transaction_base64: unsignedTransaction(t.tx),
    message_digest: messageDigest(t.tx.serializeMessage()),
    prepared_slot: '900',
    last_valid_block_height: '2000',
    signature: null,
    finalized_slot: null,
    received_lamports: '0',
    burned_tokens: '0',
    details: {},
    expectations: {
      collector: collector.publicKey.toBase58(),
      pool: fixtureWallet().publicKey.toBase58(),
      recipient: recipient.toBase58(),
      expectedLamports: '800000',
      memo: 'RINSED:00000000-0000-4000-8000-000000000000',
      maximumFeeLamports: '10000',
      operatingCostLamports: '10000',
    },
  };
  const saved = structuredClone(job),
    liabilities = vi.fn(async () => 800000n);
  const store = {
    job: async () => saved,
    assertNoUnsettledSigned: vi.fn(async () => {}),
    liabilities,
    custodyRequirement: async () => ({ liability: 800000n, operating: 10000n, minimumSlot: 900 }),
  } as unknown as WalletStore;
  const rpc = {
    getEpochInfo: async () => ({ blockHeight: 1000, absoluteSlot: 1000 }),
    isBlockhashValid: async () => ({ context: { slot: 1000 }, value: true }),
    getBalanceAndContext: vi.fn(async () => ({ context: { slot: 1000 }, value: 2000000 })),
  } as unknown as Connection;
  stubs.gate.mockResolvedValue({
    collector: collector.publicKey,
    treasury: fixtureWallet().publicKey,
  });
  stubs.coin.mockResolvedValue({ mint, policy_version: 'wallet-v1' });
  stubs.prepare.mockResolvedValue({ transactionBase64: job.transaction_base64 });
  return { job, saved, store, rpc, t };
}
beforeEach(() => vi.clearAllMocks());
describe('company-wallet signer policy', () => {
  it('uses the durable operating-funding route when transport strips or changes request details', async () => {
    const f = fixture();
    stubs.coin.mockResolvedValue({ mint: f.job.mint, policy_version: 'bond-v1' });
    f.saved.details = { route: 'dbc' };
    const funding = vi.fn(async (job: WalletJob) => {
      if (job.details.route !== 'dbc') throw new Error('Missing durable collection funding');
    });
    Object.assign(f.store, { assertOperatingFunding: funding });
    for (const details of [{}, { route: 'damm-v2' }]) {
      f.job.details = details;
      await expect(validateWalletSignJob(f.job, f.rpc, f.store, limits)).resolves.toHaveProperty(
        'collector'
      );
    }
    expect(funding).toHaveBeenCalledWith(f.saved);
    expect(funding.mock.calls.every(([job]) => job === f.saved)).toBe(true);
  });
  it('requires enough real cash for temporary WSOL rent even when it is not an operating expense', async () => {
    const f = fixture();
    f.job.expectations.temporaryFundingLamports = '2039280';
    f.saved.expectations.temporaryFundingLamports = '2039280';
    await expect(validateWalletSignJob(f.job, f.rpc, f.store, limits)).rejects.toThrow(
      'Company operating funds'
    );
    vi.mocked(f.rpc.getBalanceAndContext).mockResolvedValue({
      context: { slot: 1000 },
      value: 3000000,
    });
    await expect(validateWalletSignJob(f.job, f.rpc, f.store, limits)).resolves.toHaveProperty(
      'collector'
    );
  });
  it('independently refuses buyback budgets below 0.025 SOL', async () => {
    const f = fixture();
    f.job.kind = 'buyback';
    f.job.lamports = '24999999';
    Object.assign(f.saved, f.job);
    await expect(
      validateWalletSignJob(f.job, f.rpc, f.store, {
        ...limits,
        maximumBuybackLamports: '50000000',
      })
    ).rejects.toThrow('0.025 SOL minimum');
    expect(stubs.prepare).not.toHaveBeenCalled();
  });
  it('returns a valid signed wire for durable storage before the caller checks a newly closed gate', async () => {
    const f = fixture();
    stubs.exchange.mockImplementation(async () => {
      stubs.gate.mockRejectedValue(new Error('Worker was paused'));
      return {
        protocol: WALLET_SIGN_PROTOCOL,
        jobId: f.job.id,
        messageDigest: f.job.message_digest,
        signedTransactionBase64: f.t.tx.serialize().toString('base64'),
        signature: f.t.signature,
      };
    });
    const signer = new WalletExternalSigner(f.rpc, fixtureGenesis, {
      executable: process.execPath,
      argv: [],
      timeoutMs: 30000,
    });
    expect((await signer.sign(f.job)).signature).toBe(f.t.signature);
    expect(stubs.gate).toHaveBeenCalledOnce();
  });
  it('reconstructs an exact reserved payout before releasing the transaction for signing', async () => {
    const f = fixture();
    expect(
      (await validateWalletSignJob(f.job, f.rpc, f.store, limits)).transaction.serializeMessage()
    ).toEqual(f.t.tx.serializeMessage());
    expect(stubs.prepare).toHaveBeenCalledOnce();
  });
  it('rejects beneficiary changes and already signed attempts', async () => {
    const f = fixture();
    f.job.recipient = fixtureWallet().publicKey.toBase58();
    await expect(validateWalletSignJob(f.job, f.rpc, f.store, limits)).rejects.toThrow('durable');
    f.job.recipient = f.saved.recipient;
    f.saved.signature = f.t.signature;
    await expect(validateWalletSignJob(f.job, f.rpc, f.store, limits)).rejects.toThrow('durable');
  });
  it('rejects an extra outgoing transfer even if its message was persisted', async () => {
    const f = fixture(),
      tx = Transaction.from(Buffer.from(f.job.transaction_base64!, 'base64'));
    tx.add(
      SystemProgram.transfer({
        fromPubkey: f.t.payer.publicKey,
        toPubkey: fixtureWallet().publicKey,
        lamports: 1,
      })
    );
    f.saved.transaction_base64 = f.job.transaction_base64 = tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');
    f.saved.message_digest = f.job.message_digest = messageDigest(tx.serializeMessage());
    await expect(validateWalletSignJob(f.job, f.rpc, f.store, limits)).rejects.toThrow(
      'reconstructed Meteora'
    );
  });
  it('protects funded liabilities even when a user claim exceeds the treasury limit', async () => {
    const f = fixture();
    vi.mocked(f.rpc.getBalanceAndContext).mockResolvedValue({
      context: { slot: 1000 },
      value: 805000,
    });
    await expect(
      validateWalletSignJob(f.job, f.rpc, f.store, { ...limits, maximumPayoutLamports: '700000' })
    ).rejects.toThrow('all reward liabilities');
    vi.mocked(f.rpc.getBalanceAndContext).mockResolvedValue({
      context: { slot: 1000 },
      value: 2000000,
    });
    await expect(
      validateWalletSignJob(f.job, f.rpc, f.store, { ...limits, maximumPayoutLamports: '700000' })
    ).resolves.toHaveProperty('transaction');
  });
  it('retains the private cap for treasury withdrawals', async () => {
    const f = fixture();
    f.job.kind = f.saved.kind = 'platform_claim';
    await expect(
      validateWalletSignJob(f.job, f.rpc, f.store, { ...limits, maximumPayoutLamports: '700000' })
    ).rejects.toThrow('treasury payout limit');
  });
});
describe('private wallet signer configuration', () => {
  const policy = () => ({
    version: 1,
    purpose: 'rinsed-wallet-signer',
    keyFile: process.platform === 'win32' ? 'C:/private/collector.json' : '/private/collector.json',
    environment: {
      RPC_URL: 'https://rpc.example.invalid/',
      DATABASE_URL: 'postgresql://localhost/example',
      DATABASE_SSL_CA: process.platform === 'win32' ? 'C:/private/ca.pem' : '/private/ca.pem',
      NEXT_PUBLIC_NETWORK: 'mainnet-beta',
      FEE_COLLECTOR_PUBLIC_KEY: '5iskTyXpKn7HeqvNUFBFc1rv2C2EoFNBNyFmXgGFztgS',
      TREASURY_PUBLIC_KEY: 'GfgpgQa2ZqNm17rJ6fw2t5nBApKKPZBn5M5niWW3riZZ',
      WALLET_WORKER_ENABLED: 'true',
      MAINNET_TRADING_ENABLED: 'true',
    },
    limits: { ...limits },
  });
  it('accepts explicit ordinary owner wallets without a native program setting', () => {
    expect(walletSignerConfig(policy()).purpose).toBe('rinsed-wallet-signer');
  });
  it('requires the Dev collector, treasury and pool config pin for mainnet Dev', () => {
    const p = policy();
    const environment = {
      ...p.environment,
      LAUNCH_POLICY_VERSION: 'dev-v1',
      FEE_COLLECTOR_PUBLIC_KEY: devCompany.collector,
      TREASURY_PUBLIC_KEY: devCompany.treasury,
    };
    expect(() => walletSignerConfig({ ...p, environment })).toThrow('pool config pin');
    const POOL_CONFIG_KEY = fixtureWallet().publicKey.toBase58();
    expect(
      walletSignerConfig({ ...p, environment: { ...environment, POOL_CONFIG_KEY } }).environment
        .POOL_CONFIG_KEY
    ).toBe(POOL_CONFIG_KEY);
  });
  it('rejects disabled or missing explicit gates, inherited settings and swapped wallets', () => {
    const p = policy();
    p.environment.MAINNET_TRADING_ENABLED = 'false';
    expect(() => walletSignerConfig(p)).toThrow('gates');
    p.environment.MAINNET_TRADING_ENABLED = 'true';
    expect(() =>
      walletSignerConfig({
        ...p,
        environment: { ...p.environment, NODE_OPTIONS: '--require unsafe' },
      })
    ).toThrow('environment');
    p.environment.FEE_COLLECTOR_PUBLIC_KEY = fixtureWallet().publicKey.toBase58();
    expect(() => walletSignerConfig(p)).toThrow('owner-provided');
    expect(() =>
      walletSignerConfig({ ...policy(), vaultProgramId: fixtureWallet().publicKey.toBase58() })
    ).toThrow('fields');
  });
});
