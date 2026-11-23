import type { Coin } from '@/lib/coin';
import { useCoins, useTrending } from '@/hooks/useCoins';
import { formatReadableNumber } from '@/lib/format/number';
import { cn } from '@/lib/utils';
import { CoinAvatar } from '../coin/CoinAvatar';
import { CoinLink } from '../coin/CoinLink';

type Item = { coin: Coin; group: 'runner' | 'trending' | 'new'; rank: number; meta: string };

// Below this many items the strip sits still instead of scrolling
const MARQUEE_MIN_ITEMS = 8;

/** Top strip: highest runners by market cap and trending coins by activity. */
export const RunnersBanner = () => {
  const { data: trending } = useTrending();
  const { data: coins } = useCoins();

  const runners: Item[] = (trending?.runners ?? []).map((coin, i) => ({
    coin,
    group: 'runner',
    rank: i + 1,
    meta: `${formatReadableNumber(coin.marketCapSol)} SOL`,
  }));
  const hot: Item[] = trending?.trending.length
    ? trending.trending.map((coin, i) => ({
        coin,
        group: 'trending',
        rank: i + 1,
        meta: `${coin.txLastHour} tx/h`,
      }))
    : (coins ?? [])
        .slice(0, 6)
        .map((coin, i) => ({ coin, group: 'new', rank: i + 1, meta: 'new' }));

  const items = [...runners, ...hot];
  const animate = items.length >= MARQUEE_MIN_ITEMS;

  if (!trending && !coins) {
    return (
      <div className="h-11 animate-pulse rounded-xl border border-neutral-850 bg-neutral-950" />
    );
  }

  return (
    <div className="marquee-host relative flex h-11 items-center overflow-hidden rounded-xl border border-neutral-850 bg-neutral-950">
      <div
        className={cn(
          'flex shrink-0 items-center',
          animate ? 'marquee' : 'overflow-x-auto scrollbar-none'
        )}
        style={
          animate
            ? ({ '--marquee-duration': `${items.length * 4}s` } as React.CSSProperties)
            : undefined
        }
      >
        {(animate ? [...items, ...items] : items).map((item, i) => (
          <BannerItem
            key={`${item.group}-${item.coin.mint}-${i}`}
            item={item}
            groupStart={isGroupStart(items, i % items.length)}
          />
        ))}
      </div>
      {animate && (
        <>
          <div className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-neutral-950 to-transparent" />
          <div className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-neutral-950 to-transparent" />
        </>
      )}
    </div>
  );
};

const isGroupStart = (items: Item[], i: number) =>
  i === 0 || items[i - 1]?.group !== items[i]?.group;

const GROUP_LABEL = { runner: 'Top runners', trending: 'Trending', new: 'Just launched' } as const;
const GROUP_ICON = {
  runner: 'ph--trophy-fill text-amber',
  trending: 'ph--flame-fill text-bubble',
  new: 'ph--sparkle-fill text-primary',
} as const;

const BannerItem = ({ item, groupStart }: { item: Item; groupStart: boolean }) => (
  <>
    {groupStart && (
      <span className="ml-3 mr-1 flex shrink-0 items-center gap-1.5 border-l border-neutral-850 pl-3 first:ml-0 first:border-l-0">
        <span className={cn('iconify h-3.5 w-3.5', GROUP_ICON[item.group])} />
        <span className="eyebrow whitespace-nowrap">{GROUP_LABEL[item.group]}</span>
      </span>
    )}
    <CoinLink
      mint={item.coin.mint}
      className="flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1 transition-colors hover:bg-neutral-900"
    >
      {item.group === 'runner' && (
        <span className="font-mono text-[11px] text-neutral-600">{item.rank}</span>
      )}
      <CoinAvatar
        image={item.coin.image}
        symbol={item.coin.symbol}
        className="h-5 w-5 rounded text-[10px]"
      />
      <span className="text-sm font-medium">${item.coin.symbol}</span>
      <span className="font-mono text-xs tabular text-neutral-500">{item.meta}</span>
    </CoinLink>
  </>
);
