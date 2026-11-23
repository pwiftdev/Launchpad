import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { formatReadableNumber } from '@/lib/format/number';

export function useSolPrice() {
  return useQuery({
    queryKey: ['sol-price'],
    queryFn: async () => {
      const res = await fetch('/api/sol-price');
      if (!res.ok) throw new Error('SOL price unavailable');
      return ((await res.json()) as { usd: number }).usd;
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

const compact = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});
const dollars = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

/** "$25.7K" for big values, "$4.18" for small, "<$0.01" for dust. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return '—';
  if (usd !== 0 && Math.abs(usd) < 0.01) return '<$0.01';
  return Math.abs(usd) >= 10_000 ? compact.format(usd) : dollars.format(usd);
}

/**
 * Converts SOL amounts to formatted dollars with the live SOL price.
 * Falls back to "x SOL" until the price has loaded (or if it can't be fetched).
 */
export function useUsd() {
  const { data: price } = useSolPrice();
  const usd = useCallback(
    (sol: number) => (price ? formatUsd(sol * price) : `${formatReadableNumber(sol)} SOL`),
    [price]
  );
  return { usd, price };
}
