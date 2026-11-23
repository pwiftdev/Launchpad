import { useQuery } from '@tanstack/react-query';
import type { Coin } from '@/lib/coin';
import type { MarketStats, TokenMarket } from '@/lib/market';
import { summarizeMarket } from '@/lib/market';
import { getDemoTrades } from '@/lib/demo';

const demoCache = new Map<string, TokenMarket>();
export function demoMarket(coin: Coin): TokenMarket {
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
