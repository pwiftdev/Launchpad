import { beforeEach, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import type { NextApiRequest, NextApiResponse } from 'next';
const mocks = vi.hoisted(() => ({
  network: vi.fn(),
  tx: vi.fn(),
  account: vi.fn(),
  pool: vi.fn(),
  registered: vi.fn(),
  intent: vi.fn(),
  save: vi.fn(),
  config: vi.fn(),
  digest: vi.fn(),
  reviewed: vi.fn(),
  program: vi.fn(),
  proof: vi.fn(),
  coin: vi.fn(),
}));
vi.mock('@/server/apiGuard', () => ({ apiGuard: () => true }));
vi.mock('@/server/dbc', () => ({
  connection: { getTransaction: mocks.tx, getAccountInfo: mocks.account },
  networkGenesis: mocks.network,
  getConfig: mocks.config,
  invalidateCoinDiscovery: vi.fn(),
}));
vi.mock('@/server/launchRegistry', () => ({
  registeredCoin: mocks.registered,
  launchIntent: mocks.intent,
  recordFinalizedLaunch: mocks.save,
}));
vi.mock('@/server/launchConfig', () => ({
  configuredVaultProgram: mocks.program,
  verifyConfigAccount: mocks.digest,
  verifyLaunchConfig: mocks.reviewed,
}));
vi.mock('@/server/launchProof', () => ({ proveLaunchCreation: mocks.proof }));
vi.mock('@/lib/vault/state', () => ({ decodeVaultCoin: mocks.coin }));
vi.mock('@meteora-ag/dynamic-bonding-curve-sdk', () => ({
  DynamicBondingCurveClient: class {
    state = { getPoolByBaseMint: mocks.pool };
  },
}));
import handler from '@/pages/api/launch/confirm';
const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const genesis = key(1).toBase58(),
  mint = key(2),
  creator = key(3),
  config = key(4),
  pool = key(5),
  program = key(6),
  signature = bs58.encode(new Uint8Array(64).fill(7)),
  digest = 'a'.repeat(64);
async function confirm(includeGenesis = true) {
  let code = 200,
    body: Record<string, unknown> = {};
  const res = {
    status: (value: number) => {
      code = value;
      return res;
    },
    json: (value: Record<string, unknown>) => {
      body = value;
      return res;
    },
  };
  await handler(
    {
      method: 'POST',
      body: { mint: mint.toBase58(), signature, ...(includeGenesis ? { genesis } : {}) },
    } as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return { code, body };
}
beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.network.mockResolvedValue(genesis);
  mocks.registered.mockResolvedValue(null);
  mocks.intent.mockResolvedValue({
    config_key: config.toBase58(),
    deployer: creator.toBase58(),
    mode: 'creator',
    created_at: '2026-01-01T00:00:00Z',
    expires_at: '2026-01-01T00:05:00Z',
    prepared_slot: 50,
  });
  mocks.tx.mockResolvedValue({});
  mocks.pool.mockResolvedValue({
    publicKey: pool,
    account: { poolState: { config, activationPoint: { toString: () => '100' } } },
  });
  mocks.config.mockResolvedValue({
    quoteMint: new PublicKey('So11111111111111111111111111111111111111112'),
  });
  mocks.digest.mockResolvedValue(digest);
  mocks.reviewed.mockResolvedValue({
    policy_version: 'wallet-v1',
    expected_fee_claimer: key(9).toBase58(),
  });
  mocks.program.mockReturnValue(program);
  mocks.proof.mockReturnValue({ signature, slot: 60 });
  mocks.account.mockResolvedValue({ owner: program, data: Buffer.alloc(0) });
  mocks.coin.mockReturnValue({ mode: 'creator', creator, mint, pool, config, configHash: digest });
  mocks.save.mockResolvedValue({
    mint: mint.toBase58(),
    mode: 'creator',
    original_deployer: creator.toBase58(),
  });
});
it('requires a fresh matching network immediately before immutable registry persistence', async () => {
  expect((await confirm()).body).toMatchObject({
    status: 'registered',
    genesis,
    mint: mint.toBase58(),
    originalDeployer: creator.toBase58(),
  });
  expect(mocks.network).toHaveBeenNthCalledWith(1, true);
  expect(mocks.network).toHaveBeenNthCalledWith(2, true);
  expect(mocks.save).toHaveBeenCalledWith(
    expect.objectContaining({
      network_genesis: genesis,
      mint: mint.toBase58(),
      creation_signature: signature,
    })
  );
});
it('registers wallet-v1 creator/mode without any custom program/settings/coin reads', async () => {
  mocks.program.mockImplementation(() => {
    throw Error('No native program configured');
  });
  mocks.account.mockRejectedValue(Error('No native accounts exist'));
  expect((await confirm()).body.status).toBe('registered');
  expect(mocks.program).not.toHaveBeenCalled();
  expect(mocks.account).not.toHaveBeenCalled();
  expect(mocks.proof).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ policyVersion: 'wallet-v1', mode: 'creator', preparedSlot: 50 })
  );
  expect(mocks.proof.mock.calls[0]![1].vaultProgram).toBeUndefined();
});
it('does not persist or report registered if the RPC changes network after finalized reads', async () => {
  mocks.network.mockResolvedValueOnce(genesis).mockResolvedValueOnce(key(8).toBase58());
  const result = await confirm();
  expect(result.code).toBe(409);
  expect(result.body.status).toBeUndefined();
  expect(mocks.save).not.toHaveBeenCalled();
});
it('rejects a receipt for another network before reading or persisting a launch', async () => {
  mocks.network.mockResolvedValue(key(8).toBase58());
  expect((await confirm()).code).toBe(409);
  expect(mocks.registered).not.toHaveBeenCalled();
  expect(mocks.tx).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});
it('retains legacy confirmation without expiry context and idempotent registered recovery', async () => {
  mocks.registered.mockResolvedValue({
    mint: mint.toBase58(),
    mode: 'creator',
    original_deployer: creator.toBase58(),
    creation_signature: signature,
  });
  expect((await confirm(false)).body).toMatchObject({ status: 'registered', genesis });
  expect(mocks.network).toHaveBeenCalledTimes(1);
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.tx).not.toHaveBeenCalled();
});
