import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { Coin } from '@/lib/coin';
import type { MarketStats, TokenMarket } from '@/lib/market';
import { summarizeMarket, totalPoolReserves } from '@/lib/market';
import { getDemoCoins, getDemoTrades } from '@/lib/demo';
import type { SolanaMarket } from '@/lib/solanaMarket';
import { useDemoMode } from './useDemoMode';

const demoCache = new Map<string, TokenMarket>();
function demoMarket(coin: Coin): TokenMarket {
  let data = demoCache.get(coin.mint);
  if (!data) {
    const history = getDemoTrades(coin);
    data = summarizeMarket(
      history.trades,
      coin.marketCapSol,
      false,
      (history.trades[0]?.ts ?? coin.launchedAt) + 5
    );
    demoCache.set(coin.mint, data);
  }
  return data;
}

export function useMarketStats() {
  return useQuery<MarketStats>({
    queryKey: ['market-stats'],
    queryFn: async () => {
      const response = await fetch('/api/market-stats');
      if (!response.ok) throw new Error('Market statistics unavailable');
      return response.json();
    },
    staleTime: 30_000,
    refetchInterval: (data) => (data?.updatedAt ? 60_000 : 3000),
    retry: 1,
  });
}

export function useTokenMarket(coin: Coin) {
  const query = useMarketStats();
  return coin.isDemo ? demoMarket(coin) : query.data?.tokens[coin.mint];
}

export function useLaunchpadMarket(coins: Coin[] | undefined) {
  const { visible: preview } = useDemoMode();
  const { data, isFetching } = useMarketStats();
  const samples = useMemo(() => (preview ? getDemoCoins().map(demoMarket) : []), [preview]);
  const volume = preview
    ? samples.reduce((sum, token) => sum + token.volumeSol, 0)
    : data?.trackedPools
      ? data.volumeSol
      : null;
  const swaps = preview
    ? samples.reduce((sum, token) => sum + token.trades, 0)
    : data?.trackedPools
      ? data.trades
      : null;
  const liquidity = useMemo(() => (coins ? totalPoolReserves(coins) : undefined), [coins]);
  const coverage = preview
    ? 'Simulated sample activity. No real funds or trading.'
    : 'Recent swap samples within 24 hours. ' +
      (data ? `${data.trackedPools} of ${data.totalPools} pools sampled.` : 'Loading.');
  return { data, isFetching, preview, volume, swaps, liquidity, coverage };
}

export function useSolanaMarket() {
  return useQuery<SolanaMarket>({
    queryKey: ['solana-market'],
    queryFn: async ({ signal }) => {
      const timeout = AbortSignal.timeout(6000);
      const response = await fetch('/api/solana-market', {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) throw new Error('Solana market statistics unavailable');
      return response.json();
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    retry: 1,
  });
}
