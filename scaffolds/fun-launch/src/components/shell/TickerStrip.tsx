import type { Coin } from '@/lib/coin';
import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { useCoins, useTrending } from '@/hooks/useCoins';
import { useLocalSetting } from '@/hooks/useLocalSetting';
import { useWatchlist } from '@/hooks/useWatchlist';
import { useUsd } from '@/hooks/useUsd';
import { cn } from '@/lib/utils';
import { CoinAvatar } from '../coin/CoinAvatar';
import { CoinLink } from '../coin/CoinLink';
import { TaxBadge } from '../coin/TaxBadge';

type Mode = 'watchlist' | 'runners' | 'trending' | 'new';

const MODES: { id: Mode; label: string; icon: string }[] = [
  { id: 'watchlist', label: 'Starred', icon: 'ph--star-fill' },
  { id: 'runners', label: 'Top runners', icon: 'ph--trophy-fill' },
  { id: 'trending', label: 'Trending', icon: 'ph--flame-fill' },
  { id: 'new', label: 'Just launched', icon: 'ph--sparkle-fill' },
];

// Below this many items the strip sits still instead of scrolling
const MARQUEE_MIN_ITEMS = 8;

/** Strip under the top bar: watchlist, top runners, trending or newest coins. */
export const TickerStrip = () => {
  const [mode, setMode] = useLocalSetting<Mode>('rinsed.strip', 'watchlist');
  const router = useRouter();
  useEffect(() => {
    if (router.query.watchlist === '1') setMode('watchlist');
  }, [router.query.watchlist, setMode]);
  const { data: coins } = useCoins();
  const rankings = mode === 'runners' || mode === 'trending';
  const rankingQuery = useTrending(rankings);
  const trending = rankingQuery.data;
  const rankingStale = !!trending && (!!trending.stale || rankingQuery.isError);
  const { mints, tokens } = useWatchlist();
  const { usd } = useUsd();

  const byMint = new Map((coins ?? []).map((c) => [c.mint, c]));
  const withMcap = (c: Coin) => ({ coin: c, meta: usd(c.marketCapSol) });
  // Nothing starred yet: show the newest launches rather than an empty strip
  const starHint = mode === 'watchlist' && mints.length === 0 && !!coins?.length;
  const shown = starHint ? 'new' : mode;
  const items: {
    coin: Pick<Coin, 'mint' | 'symbol' | 'image'> &
      Partial<Pick<Coin, 'isMigrated' | 'launchedAt' | 'isDemo' | 'feePolicyVersion'>>;
    meta: string;
  }[] =
    shown === 'watchlist'
      ? mints.map((m) => {
          const coin = byMint.get(m);
          return coin
            ? withMcap(coin)
            : {
                coin: {
                  mint: m,
                  symbol: tokens[m]?.symbol ?? `${m.slice(0, 4)}…${m.slice(-4)}`,
                  image: tokens[m]?.image ?? null,
                },
                meta: 'Waiting for data',
              };
        })
      : shown === 'runners'
        ? (trending?.runners ?? []).map((coin) => withMcap(byMint.get(coin.mint) ?? coin))
        : shown === 'trending'
          ? (trending?.trending ?? []).map((c) => ({ coin: c, meta: `${c.txLastHour} tx/h` }))
          : (coins ?? []).slice(0, 12).map(withMcap);

  const animate = shown !== 'watchlist' && items.length >= MARQUEE_MIN_ITEMS;
  const empty =
    rankings && !trending && rankingQuery.isLoading
      ? 'Loading market rankings…'
      : rankings && !trending && rankingQuery.isError
        ? 'Rankings unavailable. Reconnecting…'
        : mode === 'watchlist'
          ? 'Nothing starred yet. Tap ☆ on any coin to follow it here.'
          : mode === 'trending'
            ? 'Nothing traded in the last hour.'
            : 'No coins yet.';

  return (
    <div className="flex h-10 shrink-0 items-center border-b border-white/[0.08] bg-panel">
      <div
        role="tablist"
        aria-label="Strip"
        className="flex h-full shrink-0 items-center gap-0.5 border-r border-neutral-850 px-2"
      >
        {MODES.map((m) => (
          <button
            key={m.id}
            role="tab"
            aria-selected={mode === m.id}
            aria-label={m.label}
            title={m.label}
            onClick={() => setMode(m.id)}
            className={cn(
              'flex h-7 items-center justify-center gap-1.5 rounded-md transition-colors',
              m.id === 'watchlist' ? 'px-2' : 'w-7',
              mode === m.id
                ? 'bg-neutral-900 text-primary'
                : 'text-neutral-600 hover:text-neutral-300'
            )}
          >
            <span className={cn('iconify h-4 w-4', m.icon)} />
            {m.id === 'watchlist' && (
              <span className="text-xs font-medium">
                Starred <span className="text-neutral-500">{mints.length}</span>
              </span>
            )}
          </button>
        ))}
      </div>

      {starHint && (
        <span
          className="hidden h-full shrink-0 items-center gap-1.5 border-r border-neutral-850 px-3 text-[11px] text-neutral-500 sm:flex"
          title="Tap ☆ on any coin to follow it here"
        >
          <span className="iconify h-3.5 w-3.5 text-primary ph--sparkle-fill" />
          Just launched
        </span>
      )}
      <div className="marquee-host relative h-full min-w-0 flex-1 overflow-hidden">
        {items.length === 0 ? (
          <p className="flex h-full items-center truncate px-4 text-xs text-neutral-500">{empty}</p>
        ) : (
          <div
            className={cn(
              'flex h-full items-center',
              animate ? 'marquee w-max' : 'overflow-x-auto scrollbar-none'
            )}
            style={
              animate
                ? ({ '--marquee-duration': `${items.length * 4}s` } as React.CSSProperties)
                : undefined
            }
          >
            {(animate ? [...items, ...items] : items).map(({ coin, meta }, i) => (
              <CoinLink
                key={`${coin.mint}-${i}`}
                mint={coin.mint}
                className="flex h-full shrink-0 items-center gap-2 border-r border-neutral-900 px-3.5 transition-colors hover:bg-primary/5"
              >
                {mode === 'runners' && (
                  <span className="font-mono text-[11px] text-neutral-600">
                    {(i % items.length) + 1}
                  </span>
                )}
                <CoinAvatar
                  image={coin.image}
                  symbol={coin.symbol}
                  className="h-5 w-5 rounded text-[10px]"
                />
                <span className="text-[13px] font-medium">${coin.symbol}</span>
                <span className="font-mono text-xs tabular text-neutral-500">{meta}</span>
                {!coin.isMigrated && coin.launchedAt !== undefined && (
                  <TaxBadge
                    launchedAt={coin.launchedAt}
                    isMigrated={coin.isMigrated}
                    isDemo={coin.isDemo}
                    feePolicyVersion={coin.feePolicyVersion}
                    hideWhenClean
                  />
                )}
              </CoinLink>
            ))}
          </div>
        )}
        {animate && (
          <div className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-background to-transparent" />
        )}
      </div>
      {rankings && (rankingStale || trending?.partial) && (
        <span
          className="shrink-0 border-l border-neutral-850 px-2 text-[9px] text-amber"
          role="status"
          title="Some activity is unavailable. Showing the last readable data."
        >
          {rankingStale ? 'Updates delayed' : 'Partial activity'}
        </span>
      )}
    </div>
  );
};
