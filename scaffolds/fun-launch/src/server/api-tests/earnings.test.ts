import { randomUUID } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { maskedClaimMessage, type MaskedClaimRequest } from '@/lib/maskedEarnings';
import { fixtureWallet } from '../economics/financialFixtures';
import handler from '@/pages/api/earnings';

const mocks = vi.hoisted(() => ({
  genesis: vi.fn(),
  expectedGenesis: vi.fn(),
  earnings: vi.fn(),
  claim: vi.fn(),
  gate: vi.fn(),
}));
vi.mock('@/server/apiGuard', () => ({ apiGuard: () => true, takeLimit: () => true }));
vi.mock('@/server/dbc', () => ({ connection: {}, networkGenesis: mocks.genesis }));
vi.mock('@/server/launchConfig', () => ({ expectedGenesis: mocks.expectedGenesis }));
vi.mock('@/server/economics/walletGate', () => ({ assertWalletExecutionGate: mocks.gate }));
vi.mock('@/server/economics/maskedClaimStore', () => ({
  MaskedClaimStore: class {
    earnings = mocks.earnings;
    requestClaim = mocks.claim;
  },
  MaskedClaimError: class extends Error {},
}));

const origin = 'https://masked.test';
vi.mock('@/server/siteOrigin', () => ({ siteOriginForHeaders: () => origin }));

const wallet = fixtureWallet();
const genesis = fixtureWallet().publicKey.toBase58();

function signedClaim(currency: MaskedClaimRequest['currency']) {
  const input = {
    networkGenesis: genesis,
    wallet: wallet.publicKey.toBase58(),
    currency,
    lamports: '50000000',
    requestId: randomUUID(),
    issuedAt: Date.now(),
  };
  const signature = ed25519.sign(
    Buffer.from(maskedClaimMessage(origin, input)),
    wallet.secretKey.slice(0, 32)
  );
  return { ...input, action: 'claim', signature: Buffer.from(signature).toString('base64') };
}

async function post(body: object) {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  await handler(
    { method: 'POST', body, headers: {} } as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('DATABASE_URL', 'postgres://fixture.invalid/test');
  mocks.genesis.mockResolvedValue(genesis);
  mocks.expectedGenesis.mockReturnValue(genesis);
  mocks.claim.mockResolvedValue({ currency: 'wxmr', status: 'queued' });
});
afterEach(() => vi.unstubAllEnvs());

describe('Masked earnings claims', () => {
  it('serves public balances and history from the configured ledger without a wallet signature or RPC call', async () => {
    const data = { totalLamports: '50000000', history: [{ currency: 'wxmr', status: 'paid' }] };
    mocks.earnings.mockResolvedValueOnce(data);
    const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    const address = wallet.publicKey.toBase58();
    await handler(
      { method: 'GET', query: { wallet: address } } as unknown as NextApiRequest,
      res as unknown as NextApiResponse
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(data);
    expect(mocks.earnings).toHaveBeenCalledWith(genesis, address);
    expect(mocks.genesis).not.toHaveBeenCalled();
    expect(mocks.gate).not.toHaveBeenCalled();
  });
  it('accepts a signed wXMR claim through the wallet execution gate', async () => {
    const body = signedClaim('wxmr');
    expect((await post(body)).status).toHaveBeenCalledWith(202);
    expect(mocks.gate).toHaveBeenCalledOnce();
    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        currency: 'wxmr',
        lamports: 50_000_000n,
        requestId: body.requestId,
      })
    );
  });

  it('keeps native XMR and Monero addresses out of new public claims', async () => {
    expect((await post(signedClaim('xmr'))).status).toHaveBeenCalledWith(400);
    const body = { ...signedClaim('wxmr'), moneroAddress: 'unused' };
    expect((await post(body)).status).toHaveBeenCalledWith(400);
    expect(mocks.genesis).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('requires the signed amount to match the submitted wXMR claim', async () => {
    const body = { ...signedClaim('wxmr'), lamports: '60000000' };
    expect((await post(body)).status).toHaveBeenCalledWith(401);
    expect(mocks.claim).not.toHaveBeenCalled();
  });
});
