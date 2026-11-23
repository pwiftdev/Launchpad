import { beforeEach, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import bs58 from 'bs58';
const rpc = vi.hoisted(() => ({
  getSignatureStatuses: vi.fn(),
  getBlockHeight: vi.fn(),
  getFirstAvailableBlock: vi.fn(),
  networkGenesis: vi.fn(),
}));
vi.mock('@/server/apiGuard', () => ({ apiGuard: () => true }));
vi.mock('@/server/dbc', () => ({ connection: rpc, networkGenesis: rpc.networkGenesis }));
import handler from '@/pages/api/transaction-status';
const signature = bs58.encode(new Uint8Array(64).fill(3));
beforeEach(() => {
  rpc.networkGenesis.mockReset().mockResolvedValue('fixture');
  rpc.getSignatureStatuses.mockResolvedValue({ value: [null] });
  rpc.getBlockHeight.mockResolvedValue(200);
  rpc.getFirstAvailableBlock.mockResolvedValue(50);
});
async function status(query: Record<string, string> = {}) {
  let code = 200,
    body: Record<string, unknown> = {};
  const response = {
    setHeader() {},
    status(value: number) {
      code = value;
      return this;
    },
    json(value: Record<string, unknown>) {
      body = value;
      return this;
    },
  };
  await handler(
    {
      method: 'GET',
      query: {
        signature,
        lastValidBlockHeight: '100',
        preparedSlot: '80',
        genesis: 'fixture',
        ...query,
      },
    } as unknown as NextApiRequest,
    response as unknown as NextApiResponse
  );
  return { code, body };
}
it('does not infer expiry from signature absence when older RPC history is pruned', async () => {
  expect((await status()).body.expired).toBe(true);
  rpc.getFirstAvailableBlock.mockResolvedValue(90);
  const result = await status();
  expect(result.body.expired).toBe(false);
  expect(result.body.historyIncomplete).toBe(true);
});
it('keeps actual finalized success distinct from absence and rejects the wrong genesis', async () => {
  rpc.getSignatureStatuses.mockResolvedValue({
    value: [{ err: null, confirmationStatus: 'finalized' }],
  });
  const result = await status();
  expect(result.body.finalized).toBe(true);
  expect(result.body.confirmed).toBe(true);
  expect(result.body.expired).toBe(false);
  expect((await status({ genesis: 'other' })).code).toBe(409);
});
it('rechecks the network before declaring a saved transaction expired', async () => {
  expect((await status()).body.expired).toBe(true);
  // The URL is unchanged, but its backend changed while the display cache is still valid.
  rpc.networkGenesis.mockImplementation(async (fresh = false) => (fresh ? 'other' : 'fixture'));
  const result = await status();
  expect(result.code).toBe(409);
  expect(result.body.expired).toBeUndefined();
});
