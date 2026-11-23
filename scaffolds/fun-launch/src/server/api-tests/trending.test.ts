import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Coin, TrendingResponse } from '@/lib/coin';

const mocks = vi.hoisted(() => ({ guard: vi.fn(), list: vi.fn(), clock: vi.fn(), count: vi.fn() }));
vi.mock('@/server/apiGuard', () => ({ apiGuard: mocks.guard }));
vi.mock('@/server/dbc', () => ({ listCoins: mocks.list, displayChainTime: mocks.clock }));
vi.mock('@/server/trades', () => ({ recentTxCount: mocks.count }));
const coins = (count = 3) =>
  Array.from(
    { length: count },
    (_, index) =>
      ({
        mint: `mint-${index}`,
        pool: `pool-${index}`,
        marketCapSol: 100 - index,
        isMigrated: false,
      }) as Coin
  );
const req = { method: 'GET' } as NextApiRequest;
function response() {
  const result = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  result.status.mockReturnValue(result);
  return result;
}
async function load() {
  const { default: handler } = await import('@/pages/api/trending');
  const res = response();
  await handler(req, res as unknown as NextApiResponse);
  return { res, data: res.json.mock.calls[0]?.[0] as TrendingResponse };
}
let now: number;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  now = 1_700_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  mocks.guard.mockReturnValue(true);
  mocks.list.mockResolvedValue(coins());
  mocks.clock.mockResolvedValue(1_700_000_000);
  mocks.count.mockResolvedValue(7);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('trending display reliability', () => {
  it('shares bounded refresh work, limits score concurrency and reports sample coverage', async () => {
    mocks.list.mockResolvedValue(coins(30));
    let active = 0,
      maximum = 0;
    mocks.count.mockImplementation(async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return 8;
    });
    const [first, second] = await Promise.all([load(), load()]);
    expect(first.res.status).toHaveBeenCalledWith(200);
    expect(second.data).toEqual(first.data);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.count).toHaveBeenCalledTimes(25);
    expect(maximum).toBe(4);
    expect(first.data).toMatchObject({
      partial: true,
      stale: false,
      clockStale: false,
      unavailableScores: 0,
      transactionSampleLimit: 100,
    });
    expect(first.data.trending).toHaveLength(10);
    expect(first.data.runners).toHaveLength(10);
    await load();
    expect(mocks.count).toHaveBeenCalledTimes(25);
  });
  it('keeps a genuinely observed clock frozen on interruption without dropping usable cached rankings', async () => {
    const first = await load();
    now += 2000;
    mocks.clock.mockRejectedValue(new Error('private RPC URL must not leak'));
    const fallback = await load();
    expect(fallback.res.status).toHaveBeenCalledWith(200);
    expect(fallback.data).toMatchObject({
      serverTime: first.data.serverTime,
      stale: false,
      clockStale: true,
    });
    expect(fallback.data.trending).toEqual(first.data.trending);
    expect(mocks.count).toHaveBeenCalledTimes(3);
    now += 1000;
    await load();
    expect(mocks.clock).toHaveBeenCalledTimes(2); // retry backoff, not a new failing RPC per viewer
    now += 300_000;
    const expired = await load();
    expect(expired.res.status).toHaveBeenCalledWith(200);
    expect(expired.data).toMatchObject({ serverTime: 0, clockStale: true });
    expect(JSON.stringify(expired.data)).not.toContain('private RPC');
  });
  it('serves a last good snapshot on list failure, retries after a short backoff and expires it', async () => {
    const first = await load();
    now += 31_000;
    mocks.list.mockRejectedValue(new Error('RPC unavailable'));
    const stale = await load();
    expect(stale.res.status).toHaveBeenCalledWith(200);
    expect(stale.data.trending).toEqual(first.data.trending);
    expect(stale.data.updatedAt).toBe(first.data.updatedAt);
    expect(stale.data.stale).toBe(true);
    now += 1000;
    await load();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    now += 5000;
    await load();
    expect(mocks.list).toHaveBeenCalledTimes(3);
    now += 300_000;
    expect((await load()).res.status).toHaveBeenCalledWith(503);
  });
  it('omits unknown scores instead of fabricating zero while preserving genuine zero and partial metadata', async () => {
    mocks.count.mockImplementation((pool: string) =>
      pool === 'pool-1'
        ? Promise.reject(new Error('score failed'))
        : Promise.resolve(pool === 'pool-0' ? 9 : 0)
    );
    const { data, res } = await load();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(data).toMatchObject({ partial: true, stale: true, unavailableScores: 1 });
    expect(data.trending.map((coin) => [coin.mint, coin.txLastHour])).toEqual([['mint-0', 9]]);
    expect(data.runners).toHaveLength(3);
  });
  it('reuses only bounded last-good scores from the exact pool, never renewing their age on failure', async () => {
    mocks.count.mockImplementation((pool: string) => Promise.resolve(pool === 'pool-0' ? 9 : 4));
    await load();
    now += 31_000;
    mocks.count.mockImplementation((pool: string) =>
      pool === 'pool-0' ? Promise.reject(new Error('failed')) : Promise.resolve(2)
    );
    const stale = await load();
    expect(stale.data.trending[0]).toMatchObject({ pool: 'pool-0', txLastHour: 9 });
    expect(stale.data).toMatchObject({ partial: true, stale: true, unavailableScores: 1 });
    now += 300_000;
    const fresh = await load();
    expect(fresh.res.status).toHaveBeenCalledWith(200);
    expect(fresh.data.trending.some((row) => row.pool === 'pool-0')).toBe(false);
    expect(fresh.data.trending.every((row) => row.txLastHour === 2)).toBe(true);
  });
  it('returns temporary unavailability when every initial score is unknown, rather than an empty success', async () => {
    mocks.count.mockRejectedValue(new Error('private provider detail'));
    const { res, data } = await load();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '5');
    expect(JSON.stringify(data)).not.toContain('private provider');
    await load();
    expect(mocks.count).toHaveBeenCalledTimes(3);
  });
  it('reports genuine zero scores normally but never invents a clock on a cold outage', async () => {
    mocks.count.mockResolvedValue(0);
    mocks.clock.mockRejectedValue(new Error('clock offline'));
    const cold = await load();
    expect(cold.res.status).toHaveBeenCalledWith(200);
    expect(cold.data).toMatchObject({ serverTime: 0, clockStale: true, trending: [] });
    now += 5001;
    mocks.clock.mockResolvedValue(1_700_000_005);
    const recovered = await load();
    expect(recovered.res.status).toHaveBeenCalledWith(200);
    expect(recovered.data).toMatchObject({
      trending: [],
      partial: false,
      stale: false,
      clockStale: false,
      unavailableScores: 0,
    });
  });
  it('serves usable first-visit rankings when no chain clock has ever been available', async () => {
    mocks.clock.mockRejectedValue(new Error('clock offline'));
    const { res, data } = await load();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(data).toMatchObject({ serverTime: 0, clockStale: true, unavailableScores: 0 });
    expect(data.trending).toHaveLength(3);
    expect(data.trending.every((coin) => coin.txLastHour === 7)).toBe(true);
  });
  it('marks the 100-signature score cap as partial and bounds a hung refresh to six seconds', async () => {
    mocks.count.mockResolvedValue(100);
    expect((await load()).data.partial).toBe(true);
    now += 31_000;
    vi.useFakeTimers({ now });
    mocks.count.mockImplementation(() => new Promise(() => {}));
    const pending = load();
    await vi.advanceTimersByTimeAsync(6001);
    const stale = await pending;
    expect(stale.res.status).toHaveBeenCalledWith(200);
    expect(stale.data).toMatchObject({ stale: true, unavailableScores: 3 });
  });
  it('preserves the existing authorization and method boundaries', async () => {
    mocks.guard.mockReturnValue(false);
    expect((await load()).res.json).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
    mocks.guard.mockReturnValue(true);
    const { default: handler } = await import('@/pages/api/trending');
    const res = response();
    await handler({ method: 'POST' } as NextApiRequest, res as unknown as NextApiResponse);
    expect(res.status).toHaveBeenCalledWith(405);
  });
});
