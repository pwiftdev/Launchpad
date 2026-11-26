import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  CoinResponse,
  CoinsResponse,
  HoldersResponse,
  TradesResponse,
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
import { useLiveCoin } from './useLiveCoin';
export { invalidateCoinQueries } from './useLiveCoin';

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

const fetchTrades = (mint: string, signal?: AbortSignal) =>
  getJson<TradesResponse>(`/api/coins/${mint}/trades`, signal);
const fetchHolders = (mint: string, signal?: AbortSignal) =>
  getJson<HoldersResponse>(`/api/coins/${mint}/holders`, signal);

export function useCoins() {
  const { visible } = useDemoMode();
  const query = useQuery({
    queryKey: ['coins'],
    queryFn: async ({ signal }) => {
      const data = await getJson<CoinsResponse>('/api/coins', signal);
      if (!data.clockStale) syncServerClock(data.serverTime);
      return data;
    },
    refetchInterval: 8_000,
    staleTime: 4_000,
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

/** One coin. Renders instantly from the board's cached list, then refreshes from chain. */
export function useCoin(mint: string | undefined) {
  const client = useQueryClient();
  const live = useLiveCoin(mint, !getDemoCoin(mint));
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
    refetchInterval: live.connected ? 10000 : 4000,
    retry: (count, error) => count < 2 && !String(error).includes('not found'),
  });
}

export function useTrades(mint: string | undefined) {
  const demo = getDemoCoin(mint);
  const live = useLiveCoin(mint, !demo);
  return useQuery({
    queryKey: ['trades', mint],
    queryFn: ({ signal }) => (demo ? getDemoTrades(demo) : fetchTrades(mint!, signal)),
    enabled: !!mint,
    refetchInterval: demo ? false : live.connected ? 6000 : 3000,
    staleTime: 2_000,
    retry: 1,
  });
}

export function useHolders(mint: string | undefined) {
  const demo = getDemoCoin(mint);
  const live = useLiveCoin(mint, !demo);
  return useQuery({
    queryKey: ['holders', mint],
    queryFn: ({ signal }) => (demo ? getDemoHolders(demo) : fetchHolders(mint!, signal)),
    enabled: !!mint,
    refetchInterval: demo ? false : live.connected ? 30_000 : 20_000,
    staleTime: 15_000,
    retry: 1,
  });
}

export function useTrending(enabled = true) {
  const { visible } = useDemoMode();
  const query = useQuery({
    queryKey: ['trending'],
    enabled,
    queryFn: async () => {
      const data = await getJson<TrendingResponse>('/api/trending');
      if (!data.clockStale) syncServerClock(data.serverTime);
      return data;
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
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
