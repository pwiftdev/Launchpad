import { useEffect, useState } from 'react';
import type { Coin, HoldersResponse, TradesResponse } from '@/lib/coin';
import { cn } from '@/lib/utils';
import { useLiveCoin } from '@/hooks/useLiveCoin';

type Feed = {
  data?: TradesResponse | HoldersResponse;
  error: unknown;
  dataUpdatedAt: number;
  isFetching: boolean;
  refetch: () => unknown;
};
/** Loading, interrupted connections and stale data are visible without replacing usable panels. */
export function MarketConnection({
  coin,
  trades,
  holders,
}: {
  coin: Coin;
  trades: Feed;
  holders: Feed;
}) {
  const { connected } = useLiveCoin(coin.mint, !coin.isDemo);
  const [online, setOnline] = useState(true);
  const [now, setNow] = useState(0);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 5000);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      clearInterval(tick);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  const available = !!trades.data && !!holders.data;
  const oldest = Math.min(trades.dataUpdatedAt || Infinity, holders.dataUpdatedAt || Infinity);
  const stale = now > 0 && Number.isFinite(oldest) && now - oldest > 20000;
  const degraded =
    !online ||
    !!trades.error ||
    !!holders.error ||
    stale ||
    trades.data?.stale ||
    holders.data?.stale;
  const label = coin.isDemo
    ? 'Sample activity'
    : !online
      ? 'Offline · last loaded data'
      : degraded
        ? 'Reconnecting · last loaded data'
        : available
          ? connected
            ? 'Live on-chain activity'
            : 'On-chain activity · auto-updating'
          : 'Connecting to market data';
  const fetching = trades.isFetching || holders.isFetching;
  // One compact control: the dot is the status, a click refreshes both feeds.
  return (
    <button
      type="button"
      onClick={() => {
        void trades.refetch();
        void holders.refetch();
      }}
      disabled={!online || fetching}
      title={`${label}. Click to refresh.`}
      aria-label={`${label}. Refresh token activity`}
      className={cn(
        'inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium transition-colors hover:bg-neutral-850 disabled:cursor-default',
        degraded ? 'text-amber' : 'text-neutral-400'
      )}
    >
      <span role="status" className="relative flex h-2 w-2">
        {!degraded && available && !coin.isDemo && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald opacity-50" />
        )}
        <span
          className={cn(
            'relative inline-flex h-2 w-2 rounded-full',
            degraded ? 'bg-amber' : available ? 'bg-emerald' : 'animate-pulse bg-primary'
          )}
        />
        <span className="sr-only">{label}</span>
      </span>
      <span className="hidden sm:inline">
        {coin.isDemo
          ? 'Sample'
          : !online
            ? 'Offline'
            : degraded
              ? 'Delayed'
              : available
                ? 'Live'
                : 'Connecting'}
      </span>
    </button>
  );
}
