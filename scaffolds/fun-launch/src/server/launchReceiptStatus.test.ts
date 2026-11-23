import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import type { NextApiRequest, NextApiResponse } from 'next';
import bs58 from 'bs58';
import { attestLaunchPreparation } from './launchPreparation';
const rpc = vi.hoisted(() => ({
  getSignatureStatuses: vi.fn(),
  getEpochInfo: vi.fn(),
  getFirstAvailableBlock: vi.fn(),
  getAccountInfoAndContext: vi.fn(),
  isBlockhashValid: vi.fn(),
  networkGenesis: vi.fn(),
}));
vi.mock('@/server/apiGuard', () => ({ apiGuard: () => true }));
vi.mock('@/server/dbc', () => ({ connection: rpc, networkGenesis: rpc.networkGenesis }));
import handler from '@/pages/api/launch/receipt-status';
function fixture() {
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(1)),
    mint = Keypair.fromSeed(new Uint8Array(32).fill(2)),
    genesis = new PublicKey(new Uint8Array(32).fill(3)).toBase58();
  const transaction = new Transaction({
    feePayer: wallet.publicKey,
    recentBlockhash: new PublicKey(new Uint8Array(32).fill(9)).toBase58(),
  }).add(
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: mint.publicKey,
      lamports: 1,
      space: 82,
      programId: new PublicKey(new Uint8Array(32).fill(5)),
    })
  );
  const context = attestLaunchPreparation({
    transaction,
    mint: mint.publicKey.toBase58(),
    wallet: wallet.publicKey.toBase58(),
    genesis,
    preparedSlot: 50,
    lastValidBlockHeight: 100,
  });
  transaction.partialSign(wallet, mint);
  return {
    ...context,
    mint: mint.publicKey.toBase58(),
    wallet: wallet.publicKey.toBase58(),
    signature: bs58.encode(transaction.signature!),
  };
}
let saved: ReturnType<typeof fixture>;
async function check(change: Record<string, unknown> = {}) {
  const query = Object.fromEntries(
    Object.entries({ ...saved, ...change }).map(([k, v]) => [k, String(v)])
  );
  let code = 200;
  let body: Record<string, unknown> = {};
  const res = {
    setHeader: vi.fn(),
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
    { method: 'GET', query } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return { code, body };
}
beforeEach(() => {
  vi.stubEnv('ADMIN_SESSION_SECRET', 'launch-recovery-unit-secret-over-32-characters');
  saved = fixture();
  for (const mock of Object.values(rpc)) mock.mockReset();
  rpc.networkGenesis.mockResolvedValue(saved.genesis);
  rpc.getSignatureStatuses.mockResolvedValue({ value: [null] });
  rpc.getEpochInfo.mockResolvedValue({ absoluteSlot: 200, blockHeight: 150 });
  rpc.getFirstAvailableBlock.mockResolvedValue(40);
  rpc.getAccountInfoAndContext.mockResolvedValue({ context: { slot: 200 }, value: null });
  rpc.isBlockhashValid.mockResolvedValue({ context: { slot: 200 }, value: false });
});
afterEach(() => vi.unstubAllEnvs());
it('permits explicit retry for proven expiry without pretending the absent transaction failed/finalized', async () => {
  const { code, body } = await check();
  expect(code).toBe(200);
  expect(body).toMatchObject({
    state: 'expired',
    expired: true,
    failed: false,
    finalized: false,
    safeToRetry: true,
  });
  expect(rpc.getEpochInfo).toHaveBeenCalledWith({ commitment: 'finalized', minContextSlot: 50 });
  expect(rpc.getAccountInfoAndContext.mock.calls[0]![1]).toEqual({
    commitment: 'finalized',
    minContextSlot: 200,
  });
  expect(rpc.isBlockhashValid.mock.calls.map((call) => call[1])).toEqual([
    { commitment: 'finalized', minContextSlot: 200 },
    { commitment: 'confirmed', minContextSlot: 200 },
  ]);
});
it.each(['stale mint', 'stale hash', 'pruned history', 'valid hash', 'unexpired'])(
  'keeps %s evidence pending',
  async (reason) => {
    if (reason === 'stale mint')
      rpc.getAccountInfoAndContext.mockResolvedValue({ context: { slot: 199 }, value: null });
    if (reason === 'stale hash')
      rpc.isBlockhashValid.mockResolvedValue({ context: { slot: 199 }, value: false });
    if (reason === 'pruned history') rpc.getFirstAvailableBlock.mockResolvedValue(51);
    if (reason === 'valid hash')
      rpc.isBlockhashValid.mockResolvedValue({ context: { slot: 200 }, value: true });
    if (reason === 'unexpired')
      rpc.getEpochInfo.mockResolvedValue({ absoluteSlot: 200, blockHeight: 100 });
    const { body } = await check();
    expect(body).toMatchObject({
      safeToRetry: false,
      expired: false,
      failed: false,
      state: 'pending',
    });
  }
);
it('accepts harmless System dust as uninitialized, while retaining all initialized or suspicious mint shapes', async () => {
  const dust = {
    owner: SystemProgram.programId,
    data: Buffer.alloc(0),
    executable: false,
    lamports: 1,
  };
  rpc.getAccountInfoAndContext.mockResolvedValue({ context: { slot: 200 }, value: dust });
  expect((await check()).body).toMatchObject({
    safeToRetry: true,
    mintExists: false,
    mintAccountPresent: true,
  });
  for (const value of [
    { ...dust, data: Buffer.alloc(82) },
    { ...dust, owner: new PublicKey(saved.wallet) },
    { ...dust, executable: true },
  ]) {
    rpc.getAccountInfoAndContext.mockResolvedValue({ context: { slot: 200 }, value });
    expect((await check()).body.safeToRetry).toBe(false);
  }
});
it('requires actual finalized failure and a mint snapshot at least as fresh as its status slot', async () => {
  rpc.getSignatureStatuses.mockResolvedValue({
    value: [{ slot: 210, confirmationStatus: 'confirmed', err: { InstructionError: [0, 'x'] } }],
  });
  expect((await check()).body).toMatchObject({ failed: false, safeToRetry: false });
  rpc.getSignatureStatuses.mockResolvedValue({
    value: [{ slot: 210, confirmationStatus: 'finalized', err: { InstructionError: [0, 'x'] } }],
  });
  expect((await check()).body).toMatchObject({ failed: true, safeToRetry: false });
  rpc.getAccountInfoAndContext.mockResolvedValue({ context: { slot: 210 }, value: null });
  expect((await check()).body).toMatchObject({ failed: true, state: 'failed', safeToRetry: true });
  rpc.getSignatureStatuses.mockResolvedValue({
    value: [{ slot: 210, confirmationStatus: 'finalized', err: null }],
  });
  expect((await check()).body).toMatchObject({
    finalized: true,
    failed: false,
    safeToRetry: false,
  });
});
it.each(['height', 'signature', 'message', 'proof'])(
  'rejects a tampered %s before any RPC query',
  async (field) => {
    const change =
      field === 'height'
        ? { lastValidBlockHeight: 101 }
        : field === 'signature'
          ? { signature: bs58.encode(new Uint8Array(64).fill(8)) }
          : field === 'message'
            ? { messageBase64: Buffer.from('untrusted').toString('base64') }
            : { preparationProof: 'A'.repeat(43) };
    expect((await check(change)).code).toBe(400);
    expect(rpc.networkGenesis).not.toHaveBeenCalled();
  }
);
it('keeps confirmation available after MAC-secret rotation while refusing obsolete expiry authorization', async () => {
  vi.stubEnv('ADMIN_SESSION_SECRET', 'rotated-launch-recovery-secret-over-32-characters');
  const result = await check();
  expect(result.code).toBe(400);
  expect(result.body.error).toContain('Registration can still be checked');
});
it('fails closed if the network changes before or during verification', async () => {
  rpc.networkGenesis.mockResolvedValueOnce(PublicKey.default.toBase58());
  expect((await check()).code).toBe(409);
  expect(rpc.getEpochInfo).not.toHaveBeenCalled();
  rpc.networkGenesis
    .mockResolvedValueOnce(saved.genesis)
    .mockResolvedValueOnce(PublicKey.default.toBase58());
  const result = await check();
  expect(result.code).toBe(409);
  expect(result.body.safeToRetry).toBeUndefined();
});
it('fails closed for invalid finalized expiry-bank metadata and RPC failure', async () => {
  for (const epoch of [
    { absoluteSlot: 49, blockHeight: 150 },
    { absoluteSlot: 200, blockHeight: NaN },
  ]) {
    rpc.getEpochInfo.mockResolvedValue(epoch);
    expect((await check()).code).toBe(503);
  }
  rpc.getEpochInfo.mockRejectedValue(new Error('sensitive provider URL'));
  const result = await check();
  expect(result.code).toBe(503);
  expect(JSON.stringify(result.body)).not.toContain('sensitive');
  expect(result.body.safeToRetry).toBeUndefined();
});
