import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Coin, TrendingResponse } from '@/lib/coin';
const mocks = vi.hoisted(() => ({ guard: vi.fn(), store: vi.fn(), clock: vi.fn() }));
vi.mock('@/server/apiGuard', () => ({ apiGuard: mocks.guard }));
vi.mock('@/server/display', async (load) => ({
  ...(await load<typeof import('@/server/display')>()),
  displayStore: mocks.store,
  sharedClock: mocks.clock,
}));
import handler from '@/pages/api/trending';

const coin = (mint: string, marketCapSol: number, isMigrated = false) =>
  ({ mint, marketCapSol, isMigrated }) as Coin;
function response() {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}
async function read() {
  const res = response();
  await handler({ method: 'GET' } as NextApiRequest, res as unknown as NextApiResponse);
  return { res, data: res.json.mock.calls[0]?.[0] as TrendingResponse };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.guard.mockReturnValue(true);
  mocks.clock.mockResolvedValue({ serverTime: 1_800_000_000, clockStale: false, stale: false });
});

describe('trending API', () => {
  it('ranks runners by market cap and unbonded coins by swaps in the last hour', async () => {
    const coins = [coin('a', 10), coin('b', 30), coin('c', 20), coin('bonded', 99, true)];
    const counts = new Map([
      ['a', 5],
      ['b', 1],
      ['bonded', 50],
    ]);
    const store = {
      genesis: 'ranked',
      coins: vi.fn(async () => coins),
      recentSwapCounts: vi.fn(async () => counts),
    };
    mocks.store.mockReturnValue(store);
    const [{ data }] = await Promise.all([read(), read()]);
    expect(store.coins).toHaveBeenCalledOnce();
    expect(store.recentSwapCounts).toHaveBeenCalledOnce();
    expect(data.runners.map((c) => c.mint)).toEqual(['bonded', 'b', 'c', 'a']);
    expect(data.trending.map((c) => [c.mint, c.txLastHour])).toEqual([
      ['a', 5],
      ['b', 1],
    ]);
    expect(data).toMatchObject({ serverTime: 1_800_000_000, clockStale: false, partial: false });
  });

  it('returns temporary unavailability when the database fails', async () => {
    mocks.store.mockReturnValue({
      genesis: 'unavailable',
      coins: async () => Promise.reject(new Error('db down')),
      recentSwapCounts: async () => new Map(),
    });
    expect((await read()).res.status).toHaveBeenCalledWith(503);
  });
});
