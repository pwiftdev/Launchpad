import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), sync: vi.fn(), client: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: mocks.query, useQueryClient: mocks.client }));
vi.mock('./useDemoMode', () => ({ useDemoMode: () => ({ visible: false }) }));
vi.mock('./useNow', () => ({ syncServerClock: mocks.sync }));
vi.mock('./useLiveCoin', () => ({
  useLiveCoin: () => ({ connected: false }),
  invalidateCoinQueries: vi.fn(),
}));
import { useCoin, useCoins, useTrending } from './useCoins';
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());
describe('coin list display metadata', () => {
  it('keeps the public hook coin-array contract, exposes staleness and skips stale clock synchronization', async () => {
    const coin = { mint: 'real-mint' };
    const payload = { coins: [coin], serverTime: 0, stale: true, clockStale: true };
    mocks.query.mockReturnValue({ data: payload, status: 'success' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(payload))
    );
    const result = useCoins();
    expect(result.data).toEqual([coin]);
    expect(result.displayStale).toBe(true);
    const options = mocks.query.mock.calls[0]![0] as {
      queryFn: (context: { signal?: AbortSignal }) => Promise<unknown>;
    };
    expect(await options.queryFn({})).toEqual(payload);
    expect(mocks.sync).not.toHaveBeenCalled();
  });
  it('warms a selected coin from the new response-shaped board cache', () => {
    const coin = { mint: 'real-mint' };
    mocks.client.mockReturnValue({
      getQueryData: vi.fn(() => ({ coins: [coin], serverTime: 1000 })),
    });
    useCoin(coin.mint);
    const options = mocks.query.mock.calls[0]![0] as { initialData: () => unknown };
    expect(options.initialData()).toEqual(coin);
  });
  it('marks retained client data stale when the bounded server fallback has expired', () => {
    mocks.query.mockReturnValue({
      data: { coins: [{ mint: 'old-coin' }], serverTime: 1000, stale: false },
      status: 'error',
      isError: true,
    });
    const result = useCoins();
    expect(result.data).toEqual([{ mint: 'old-coin' }]);
    expect(result.displayStale).toBe(true);
  });
});
describe('trending clock integration', () => {
  it('does not synchronize the live fee clock from a stale cached timestamp', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ serverTime: 1000, clockStale: true, trending: [], runners: [] })
      )
    );
    useTrending();
    const options = mocks.query.mock.calls[0]![0] as {
      queryFn: () => Promise<unknown>;
      enabled: boolean;
    };
    expect(options.enabled).toBe(true);
    await options.queryFn();
    expect(mocks.sync).not.toHaveBeenCalled();
  });
  it('synchronizes a genuinely observed clock and disables unused ranking queries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ serverTime: 2000, clockStale: false, trending: [], runners: [] })
      )
    );
    useTrending(false);
    const options = mocks.query.mock.calls[0]![0] as {
      queryFn: () => Promise<unknown>;
      enabled: boolean;
    };
    expect(options.enabled).toBe(false);
    await options.queryFn();
    expect(mocks.sync).toHaveBeenCalledWith(2000);
  });
});
