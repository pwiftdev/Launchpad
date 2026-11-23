import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoinsResponse } from '@/lib/coin';
const mocks = vi.hoisted(() => ({ guard: vi.fn(), list: vi.fn(), clock: vi.fn() }));
vi.mock('@/server/apiGuard', () => ({ apiGuard: mocks.guard }));
vi.mock('@/server/dbc', () => ({ listCoins: mocks.list, displayChainTime: mocks.clock }));
const coin = { mint: 'real-public-coin' };
let now: number;
function response() {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}
async function read() {
  const { default: handler } = await import('@/pages/api/coins');
  const res = response();
  await handler({ method: 'GET' } as NextApiRequest, res as unknown as NextApiResponse);
  return { res, data: res.json.mock.calls[0]?.[0] as CoinsResponse };
}
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  now = 1_700_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  mocks.guard.mockReturnValue(true);
  mocks.list.mockResolvedValue([coin]);
  mocks.clock.mockResolvedValue(1_700_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('public coin display interruption handling', () => {
  it('keeps usable coin data when a warm display clock fails, without advancing its timestamp', async () => {
    const first = await read();
    now += 2000;
    mocks.clock.mockRejectedValue(new Error('slot unavailable'));
    const next = await read();
    expect(next.res.status).toHaveBeenCalledWith(200);
    expect(next.data).toMatchObject({
      coins: [coin],
      serverTime: first.data.serverTime,
      clockStale: true,
      stale: false,
    });
    await read();
    expect(mocks.clock).toHaveBeenCalledTimes(2);
  });
  it('serves usable first-visit coins with an explicitly unknown clock', async () => {
    mocks.clock.mockRejectedValue(new Error('clock unavailable'));
    const { res, data } = await read();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(data).toMatchObject({ coins: [coin], serverTime: 0, clockStale: true, stale: false });
  });
  it('retains the last good list through failure, backs off and recovers without fabricating an empty board', async () => {
    const first = await read();
    now += 11_000;
    mocks.list.mockRejectedValue(new Error('private upstream detail'));
    const fallback = await read();
    expect(fallback.res.status).toHaveBeenCalledWith(200);
    expect(fallback.data).toMatchObject({
      coins: [coin],
      updatedAt: first.data.updatedAt,
      stale: true,
    });
    await read();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    now += 5001;
    mocks.list.mockResolvedValue([{ mint: 'new-real-coin' }]);
    const recovered = await read();
    expect(recovered.data).toMatchObject({ coins: [{ mint: 'new-real-coin' }], stale: false });
  });
  it('expires old snapshots without refreshing their age on a failed retry', async () => {
    const first = await read();
    mocks.list.mockRejectedValue(new Error('unavailable'));
    for (let attempt = 0; attempt < 3; attempt++) {
      now += 30_000;
      const stale = await read();
      expect(stale.data.updatedAt).toBe(first.data.updatedAt);
      expect(stale.res.status).toHaveBeenCalledWith(200);
    }
    now += 30_001;
    const expired = await read();
    expect(expired.res.status).toHaveBeenCalledWith(503);
    expect(expired.res.setHeader).toHaveBeenCalledWith('Retry-After', '5');
    expect(expired.data.coins).toBeUndefined();
  });
  it('returns temporary unavailability on a cold list failure and avoids repeated upstream attempts', async () => {
    mocks.list.mockRejectedValue(new Error('private provider URL'));
    const { res, data } = await read();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(JSON.stringify(data)).not.toContain('private provider');
    await read();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });
  it('shares concurrent refreshes and bounds a hung refresh while retaining usable data', async () => {
    await read();
    now += 11_000;
    vi.useFakeTimers({ now });
    mocks.list.mockImplementation(() => new Promise(() => {}));
    const first = read(),
      second = read();
    await vi.advanceTimersByTimeAsync(6001);
    const [a, b] = await Promise.all([first, second]);
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(a.res.status).toHaveBeenCalledWith(200);
    expect(b.data).toEqual(a.data);
    expect(a.data).toMatchObject({ coins: [coin], stale: true });
  });
  it('preserves authorization and method checks before reading chain data', async () => {
    mocks.guard.mockReturnValue(false);
    expect((await read()).res.json).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
    mocks.guard.mockReturnValue(true);
    const { default: handler } = await import('@/pages/api/coins');
    const res = response();
    await handler({ method: 'POST' } as NextApiRequest, res as unknown as NextApiResponse);
    expect(res.status).toHaveBeenCalledWith(405);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
