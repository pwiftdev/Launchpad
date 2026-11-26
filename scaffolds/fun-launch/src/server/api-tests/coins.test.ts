import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoinsResponse } from '@/lib/coin';
const mocks = vi.hoisted(() => ({ guard: vi.fn(), store: vi.fn(), clock: vi.fn() }));
vi.mock('@/server/apiGuard', () => ({ apiGuard: mocks.guard }));
vi.mock('@/server/display', () => ({
  displayStore: mocks.store,
  sharedCoins: (store: { coins: () => Promise<unknown> }) => store.coins(),
  sharedClock: mocks.clock,
}));
import handler from '@/pages/api/coins';

function response() {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}
async function read() {
  const res = response();
  await handler({ method: 'GET' } as NextApiRequest, res as unknown as NextApiResponse);
  return { res, data: res.json.mock.calls[0]?.[0] as CoinsResponse };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.guard.mockReturnValue(true);
});

describe('board API', () => {
  it('serves the indexed board with the indexer chain clock and staleness', async () => {
    mocks.store.mockReturnValue({ coins: async () => [{ mint: 'indexed' }] });
    mocks.clock.mockResolvedValue({ serverTime: 1_800_000_000, clockStale: false, stale: false });
    const { res, data } = await read();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(data).toMatchObject({
      coins: [{ mint: 'indexed' }],
      serverTime: 1_800_000_000,
      clockStale: false,
      stale: false,
    });
  });

  it('never invents a clock: a stale indexer reports an unknown time', async () => {
    mocks.store.mockReturnValue({ coins: async (): Promise<unknown[]> => [] });
    mocks.clock.mockResolvedValue({ serverTime: 0, clockStale: true, stale: true });
    expect((await read()).data).toMatchObject({ serverTime: 0, clockStale: true, stale: true });
  });

  it('returns temporary unavailability when the database fails', async () => {
    mocks.store.mockReturnValue({ coins: async () => Promise.reject(new Error('db down')) });
    mocks.clock.mockResolvedValue({ serverTime: 0, clockStale: true, stale: true });
    const { res } = await read();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '5');
  });

  it('shows an empty, stale board without a database', async () => {
    mocks.store.mockReturnValue(null);
    expect((await read()).data).toMatchObject({ coins: [], stale: true, clockStale: true });
  });
});
