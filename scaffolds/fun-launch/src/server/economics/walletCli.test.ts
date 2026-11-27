import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Connection } from '@solana/web3.js';
import { fixtureWallet } from './financialFixtures';
const fake = vi.hoisted(() => ({
  pending: vi.fn(),
  candidates: vi.fn(),
  claimAge: vi.fn(),
  custody: vi.fn(),
  plan: vi.fn(),
  reconcile: vi.fn(),
  sign: vi.fn(),
  relay: vi.fn(),
  discover: vi.fn(),
  acquire: vi.fn(),
  end: vi.fn(),
  database: vi.fn(),
  required: vi.fn(),
  recover: vi.fn(),
  prepare: vi.fn(),
  queueWxmrPayments: vi.fn(),
  resumeMaskedWxmrClaim: vi.fn(),
}));
vi.mock('../database', () => ({
  database: () => {
    fake.database();
    return { end: fake.end };
  },
}));
vi.mock('./walletStore', () => ({
  WalletStore: class {
    pendingJobs = fake.pending;
    executionCandidates = fake.candidates;
    oldestUserClaimSeconds = fake.claimAge;
    custodyRequirement = fake.custody;
    resumeMaskedWxmrClaim = fake.resumeMaskedWxmrClaim;
  },
}));
vi.mock('./walletWorker', () => ({
  WalletMessageExpired: class extends Error {},
  WalletWorker: class {
    plan = fake.plan;
    reconcile = fake.reconcile;
    sign = fake.sign;
    relay = fake.relay;
    required = fake.required;
    recover = fake.recover;
    prepare = fake.prepare;
    queueWxmrPayments = fake.queueWxmrPayments;
  },
}));
vi.mock('./walletSchedulerStore', () => ({
  WalletSchedulerStore: class {
    acquire = fake.acquire;
    discover = fake.discover;
  },
}));
import { runWalletCli, walletCliOptions } from './walletCli';
import { WalletMessageExpired } from './walletWorker';
const genesis = fixtureWallet().publicKey.toBase58(),
  mints = [fixtureWallet().publicKey.toBase58(), fixtureWallet().publicKey.toBase58()];
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('LOCAL_VALIDATOR_ENABLED', 'true');
  vi.stubEnv('LOCAL_VALIDATOR_GENESIS_HASH', genesis);
  vi.stubEnv('NEXT_PUBLIC_NETWORK', 'localnet');
  vi.stubEnv('RPC_URL', 'http://127.0.0.1:8899');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'http://127.0.0.1');
  vi.stubEnv('SITE_ALLOWED_ORIGINS', '');
  vi.stubEnv('FEE_COLLECTOR_PUBLIC_KEY', fixtureWallet().publicKey.toBase58());
  vi.stubEnv('TREASURY_PUBLIC_KEY', fixtureWallet().publicKey.toBase58());
  vi.stubEnv('WALLET_WORKER_ENABLED', 'true');
  vi.spyOn(Connection.prototype, 'getGenesisHash').mockResolvedValue(genesis);
  vi.spyOn(Connection.prototype, 'getBalanceAndContext').mockResolvedValue({
    context: { slot: 1 },
    value: 1_000_000,
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  fake.database.mockClear();
  fake.plan.mockReset();
  fake.reconcile.mockReset();
  fake.sign.mockClear();
  fake.relay.mockClear();
  fake.recover.mockReset();
  fake.prepare.mockReset();
  fake.queueWxmrPayments.mockReset();
  fake.resumeMaskedWxmrClaim.mockReset();
  fake.required.mockReset();
  fake.pending.mockResolvedValue([{ id: 'saved', signature: 'already-signed' }]);
  fake.candidates.mockResolvedValue([{ id: 'saved' }]);
  fake.claimAge.mockResolvedValue(121);
  fake.custody.mockResolvedValue({ liability: 0n, operating: 0n, minimumSlot: 1 });
  fake.discover.mockResolvedValue(mints);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe('finite private wallet CLI', () => {
  it('help makes no RPC/config/DB calls; default scheduler/status dry run only checks genesis', async () => {
    await runWalletCli(['--help']);
    expect(Connection.prototype.getGenesisHash).not.toHaveBeenCalled();
    await runWalletCli(['status', '--mint', mints[0]!]);
    await runWalletCli([]);
    expect(Connection.prototype.getGenesisHash).toHaveBeenCalledTimes(2);
    expect(fake.database).not.toHaveBeenCalled();
    expect(fake.plan).not.toHaveBeenCalled();
    expect(fake.sign).not.toHaveBeenCalled();
    expect(JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0])).toMatchObject({
      dryRun: true,
      transactionsSigned: false,
      transactionsSent: false,
    });
  });
  it('reconciles stored signatures before unsigned plans; one coin failure does not starve the next', async () => {
    const order: string[] = [],
      lease = { alive: () => true, progress: vi.fn(), finish: vi.fn(), release: vi.fn() };
    fake.acquire.mockResolvedValue(lease);
    fake.queueWxmrPayments.mockImplementationOnce(async () => {
      order.push('queue');
      throw new Error('wXMR queue connection interrupted');
    });
    fake.reconcile.mockImplementation(async () => {
      order.push('reconcile');
    });
    fake.plan
      .mockImplementationOnce(async () => {
        order.push('plan');
        throw new Error('private provider credential');
      })
      .mockImplementationOnce(async () => {
        order.push('plan');
      });
    await runWalletCli(['run', '--execute', '--cycles', '1', '--maximum-coins', '2']);
    expect(order).toEqual(['queue', 'reconcile', 'plan', 'reconcile', 'plan']);
    expect(fake.queueWxmrPayments).toHaveBeenCalledOnce();
    expect(fake.sign).not.toHaveBeenCalled();
    expect(fake.relay).not.toHaveBeenCalled();
    expect(lease.progress).toHaveBeenCalledTimes(2);
    expect(lease.release).toHaveBeenCalledOnce();
    const result = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0]);
    expect(result).toMatchObject({
      processed: 2,
      failed: 1,
      transactionsSigned: 0,
      transactionsSent: 0,
      unsignedOnly: true,
    });
    expect(JSON.stringify(result)).not.toContain('credential');
  });
  it('does not overlap a held lease and validates bounded/unknown flags', async () => {
    fake.acquire.mockResolvedValue(null);
    await runWalletCli(['run', '--execute']);
    expect(fake.plan).not.toHaveBeenCalled();
    expect(() => walletCliOptions(['run', '--execute', '--execute'])).toThrow();
    await expect(runWalletCli(['run', '--cycles', '0'])).rejects.toThrow('bounded');
    expect(() => walletCliOptions(['run', '--private-key', 'secret'])).toThrow();
  });
  it('schedules capped Masked buybacks for the configured target only', async () => {
    fake.acquire.mockResolvedValue({
      alive: () => true,
      progress: vi.fn(),
      finish: vi.fn(),
      release: vi.fn(),
    });
    vi.stubEnv('MASKED_TEST_BUYBACK_MINT', mints[0]);
    const flags = ['run', '--execute', '--max-spend-lamports', '10000000', '--masked-buyback-only'];
    await runWalletCli(flags);
    expect(fake.plan).toHaveBeenNthCalledWith(1, mints[0], 10000000n, 20, false);
    expect(fake.plan).toHaveBeenNthCalledWith(2, mints[1], undefined, 20, false);

    fake.plan.mockClear();
    vi.stubEnv('MASKED_TEST_BUYBACK_MINT', undefined);
    await runWalletCli(flags);
    expect(fake.plan).toHaveBeenNthCalledWith(1, mints[0], undefined, 20, false);
    expect(fake.plan).toHaveBeenNthCalledWith(2, mints[1], undefined, 20, false);
  });
  it('does not release a reviewed claim for retry after lease loss', async () => {
    const lease = { alive: () => false, progress: vi.fn(), finish: vi.fn(), release: vi.fn() };
    fake.acquire.mockResolvedValue(lease);
    await expect(
      runWalletCli(['resume-wxmr', '--execute', '--id', '4ac018cf-80d8-4634-bd51-cabfebdaa54f'])
    ).rejects.toThrow('lease lost');
    expect(fake.resumeMaskedWxmrClaim).not.toHaveBeenCalled();
    expect(lease.release).toHaveBeenCalledOnce();
  });
});
it('automatic expired attempt recovery requires positive proof and waits until another tick to sign again', async () => {
  const lease = { alive: () => true, progress: vi.fn(), finish: vi.fn(), release: vi.fn() };
  fake.acquire.mockResolvedValue(lease);
  fake.discover.mockResolvedValue([mints[0]]);
  fake.pending.mockResolvedValue([{ id: 'saved', signature: 'old-signature' }]);
  fake.required
    .mockResolvedValueOnce({ id: 'saved', status: 'submitted', signature: 'old-signature' })
    .mockResolvedValueOnce({ id: 'saved', status: 'prepared', signature: null });
  fake.relay.mockRejectedValueOnce(new WalletMessageExpired());
  fake.recover.mockResolvedValue({ id: 'saved', status: 'queued' });
  fake.prepare.mockResolvedValue({ id: 'saved', status: 'prepared' });
  await runWalletCli([
    'run',
    '--execute',
    '--automatic',
    '--signer-command',
    process.execPath,
    '--cycles',
    '1',
  ]);
  expect(fake.recover).toHaveBeenCalledWith('saved');
  expect(fake.prepare).toHaveBeenCalledWith('saved');
  expect(fake.sign).not.toHaveBeenCalled();
  expect(fake.relay).toHaveBeenCalledTimes(1);
  expect(JSON.parse(vi.mocked(console.log).mock.lastCall![0]).alerts).toEqual([
    'WALLET_USER_PAYOUT_WAITING',
    'WALLET_COLLECTOR_HEADROOM_LOW',
  ]);
  expect(lease.release).toHaveBeenCalledOnce();
});
