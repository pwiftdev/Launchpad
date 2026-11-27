import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  CoinResponse,
  CoinPriceHistory,
  CoinsResponse,
  HoldersResponse,
  TrendingResponse,
} from '@/lib/coin';
import { syncServerClock } from './useNow';
import {
  getDemoCoin,
  getDemoCoins,
  getDemoHolders,
  getDemoTrades,
  getDemoTrending,
} from '@/lib/demo';
import { useDemoMode } from './useDemoMode';
import { useBoardLive } from './useBoardLive';

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(12000)])
      : AbortSignal.timeout(12000),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

const fetchHolders = (mint: string, signal?: AbortSignal) =>
  getJson<HoldersResponse>(`/api/coins/${mint}/holders?view=top`, signal);

export function useCoins() {
  const { visible } = useDemoMode();
  const live = useBoardLive();
  const query = useQuery({
    queryKey: ['coins'],
    queryFn: async ({ signal }) => {
      const data = await getJson<CoinsResponse>('/api/coins', signal);
      if (!data.clockStale) syncServerClock(data.serverTime);
      return data;
    },
    // Live updates refetch on change; the timer only covers a dropped stream.
    refetchInterval: live.connected ? 60_000 : 10_000,
    staleTime: 2_000,
  });
  const coins = visible ? [...getDemoCoins(), ...(query.data?.coins ?? [])] : query.data?.coins;
  return {
    ...query,
    data: coins,
    displayStale: !!query.data && (query.isError || !!query.data.stale),
    status: coins ? ('success' as const) : query.status,
  };
}

const fromBoard = (client: QueryClient, mint: string | undefined) =>
  mint
    ? client.getQueryData<CoinsResponse>(['coins'])?.coins.find((c) => c.mint === mint)
    : undefined;

/** One coin, starting with the board's cached list while the indexed snapshot loads. */
export function useCoin(mint: string | undefined) {
  const client = useQueryClient();
  return useQuery({
    queryKey: ['coin', mint],
    queryFn: async ({ signal }) => {
      const demo = getDemoCoin(mint);
      if (demo) return demo;
      const data = await getJson<CoinResponse>(`/api/coins/${mint}`, signal);
      syncServerClock(data.serverTime);
      return data.coin;
    },
    enabled: !!mint,
    initialData: () => getDemoCoin(mint) ?? fromBoard(client, mint),
    initialDataUpdatedAt: 0,
    refetchInterval: (coin) => (coin?.isDemo ? false : coin ? 60_000 : 15_000),
    staleTime: 15_000,
    retry: (count, error) => count < 2 && !String(error).includes('not found'),
  });
}

const PRICES_STALE_MS = 30_000;

function fetchCoinPrices(mint: string, signal?: AbortSignal): Promise<CoinPriceHistory> {
  const demo = getDemoCoin(mint);
  if (!demo) return getJson<CoinPriceHistory>(`/api/coins/${mint}/trades?view=chart`, signal);
  const prices = new Map(
    getDemoTrades(demo)
      .trades.reverse()
      .map(({ ts, priceSol }) => [ts, priceSol])
  );
  return Promise.resolve({ points: [...prices].map(([time, priceSol]) => ({ time, priceSol })) });
}

export function useCoinPrices(mint: string) {
  const demo = getDemoCoin(mint);
  return useQuery<CoinPriceHistory>({
    queryKey: ['coin-prices', mint],
    queryFn: ({ signal }) => fetchCoinPrices(mint, signal),
    refetchInterval: demo ? false : 60_000,
    staleTime: PRICES_STALE_MS,
    retry: 1,
  });
}

/**
 * Warms what the coin panel needs before it opens (on hover or touch), so the chart is
 * already drawn when the panel lands. Fresh data is left alone; failures stay silent and
 * the panel simply loads as usual.
 */
export function prefetchCoin(client: QueryClient, mint: string) {
  void client.prefetchQuery({
    queryKey: ['coin-prices', mint],
    queryFn: ({ signal }) => fetchCoinPrices(mint, signal),
    staleTime: PRICES_STALE_MS,
  });
}

export function useHolders(mint: string | undefined) {
  const demo = getDemoCoin(mint);
  return useQuery({
    queryKey: ['holders', mint],
    queryFn: ({ signal }) => (demo ? getDemoHolders(demo) : fetchHolders(mint!, signal)),
    enabled: !!mint,
    refetchInterval: demo ? false : 5 * 60_000,
    staleTime: 60_000,
    retry: 1,
  });
}

export function useTrending(enabled = true) {
  const { visible } = useDemoMode();
  const live = useBoardLive(enabled);
  const query = useQuery({
    queryKey: ['trending'],
    enabled,
    queryFn: async () => {
      const data = await getJson<TrendingResponse>('/api/trending');
      if (!data.clockStale) syncServerClock(data.serverTime);
      return data;
    },
    refetchInterval: live.connected ? 120_000 : 30_000,
    staleTime: 5_000,
  });
  if (!visible) return query;
  const data: TrendingResponse = {
    ...query.data,
    serverTime: query.data?.serverTime ?? Math.floor(Date.now() / 1000),
    runners: [...getDemoCoins(), ...(query.data?.runners ?? [])]
      .sort((a, b) => b.marketCapSol - a.marketCapSol)
      .slice(0, 10),
    trending: [...getDemoTrending(), ...(query.data?.trending ?? [])].slice(0, 10),
  };
  return {
    ...query,
    data,
  };
}
