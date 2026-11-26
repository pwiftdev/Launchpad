import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const minute = 60_000;
const hour = 3600;

function rows(url: URL) {
  const end = Date.parse(url.searchParams.get('end')!) / 1000;
  return Array.from({ length: 26 }, (_, index) => [end - index * hour, 70, 90, 75, 90 - index, 1]);
}

describe('Solana market readings', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-16T12:15:00Z'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns the 25 closed hourly prices in order and shares upstream reads', async () => {
    const fetch = vi.fn(async (url: URL) => {
      expect(url.host).toBe('api.exchange.coinbase.com');
      expect(url.searchParams.get('granularity')).toBe('3600');
      return Response.json(rows(url));
    });
    vi.stubGlobal('fetch', fetch);
    const { getSolanaMarket } = await import('./solanaMarket');
    const [a, b] = await Promise.all([getSolanaMarket(), getSolanaMarket()]);
    expect(a).toEqual(b);
    expect(a.hourlyCloses).toEqual({
      value: Array.from({ length: 25 }, (_, i) => 65 + i),
      stale: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * minute);
    await getSolanaMarket();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects incomplete price history and backs off before retrying', async () => {
    const fetch = vi.fn(async (url: URL) => Response.json(rows(url).slice(0, -1)));
    vi.stubGlobal('fetch', fetch);
    const { getSolanaMarket } = await import('./solanaMarket');
    expect(await getSolanaMarket()).toEqual({ hourlyCloses: null });
    await getSolanaMarket();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(minute);
    await getSolanaMarket();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('labels a delayed reading and drops it after the grace period', async () => {
    let offline = false;
    const fetch = vi.fn(async (url: URL) =>
      offline ? new Response(null, { status: 503 }) : Response.json(rows(url))
    );
    vi.stubGlobal('fetch', fetch);
    const { getSolanaMarket } = await import('./solanaMarket');
    const initial = (await getSolanaMarket()).hourlyCloses;
    expect(initial?.stale).toBe(false);
    offline = true;
    await vi.advanceTimersByTimeAsync(5 * minute);
    expect((await getSolanaMarket()).hourlyCloses).toEqual({ value: initial?.value, stale: true });
    await vi.advanceTimersByTimeAsync(60 * minute);
    expect((await getSolanaMarket()).hourlyCloses).toBeNull();
    offline = false;
    await vi.advanceTimersByTimeAsync(minute);
    expect((await getSolanaMarket()).hourlyCloses).toEqual(initial);
  });
});
