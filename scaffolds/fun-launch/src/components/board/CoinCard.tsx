import { memo, useEffect, useRef, useState } from 'react';
import type { Coin } from '@/lib/coin';
import { formatAge } from '@/lib/format/date';
import { formatReadableNumber } from '@/lib/format/number';
import { useNow } from '@/hooks/useNow';
import { useUsd } from '@/hooks/useUsd';
import { LAUNCH_TAX_WINDOW_SECONDS } from '@/constants/launch';
import { cn, shortenAddress } from '@/lib/utils';
import { CoinAvatar } from '../coin/CoinAvatar';
import { SplitBadge } from '@/components/coin/SplitBadge';
import { TaxBadge } from '../coin/TaxBadge';
import { CoinLink } from '../coin/CoinLink';
import { StarButton } from '../coin/StarButton';
import { AnimatedNumber } from '../ui/AnimatedNumber';
import { PriceBackdrop } from '../coin/PriceBackdrop';
import { useTokenMarket } from '@/hooks/useMarket';
import { hasCurrentTaxSchedule } from '@/lib/launchTax';
import { BondFill, HOT_BOND_PROGRESS } from '../coin/BondingBar';
import { SocialLinks } from '../coin/SocialLinks';

/** 'up' / 'down' for ~1s after the value changes, so the row can flash. */
function useChangeFlash(value: number): 'up' | 'down' | null {
  const previous = useRef(value);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    if (value === previous.current) return undefined;
    setFlash(value > previous.current ? 'up' : 'down');
    previous.current = value;
    const id = setTimeout(() => setFlash(null), 1000);
    return () => clearTimeout(id);
  }, [value]);
  return flash;
}

type CoinCardProps = {
  coin: Coin;
  /** Launched since the board loaded: slide in */
  isNew?: boolean;
  compact?: boolean;
};

export const CoinCard = memo(({ coin, isNew, compact }: CoinCardProps) => {
  const now = useNow(1000, coin.isDemo);
  const { usd } = useUsd();
  const flash = useChangeFlash(coin.marketCapSol);
  const market = useTokenMarket(coin);
  const down = (market?.changePercent ?? 0) < 0;
  const pct = coin.progress * 100;
  const hot = !coin.isMigrated && coin.progress >= HOT_BOND_PROGRESS;
  const sniping =
    hasCurrentTaxSchedule(coin) &&
    !coin.isMigrated &&
    now !== null &&
    now - coin.launchedAt < LAUNCH_TAX_WINDOW_SECONDS;

  return (
    <div
      className={cn(
        'coin-row group relative isolate overflow-hidden border-b border-neutral-800/50 last:border-b-0',
        isNew && 'animate-in fade-in slide-in-from-top-3 duration-500',
        flash === 'up' && 'row-flash-up',
        flash === 'down' && 'row-flash-down',
        sniping && 'snipe-sheen'
      )}
    >
      {market && (
        <PriceBackdrop
          points={market.points}
          down={down}
          className="absolute -right-3 bottom-0 top-0 -z-10 h-full w-[64%] opacity-30 transition-opacity duration-300 group-hover:opacity-55"
        />
      )}
      <CoinLink
        mint={coin.mint}
        aria-label={`${coin.name} ($${coin.symbol})`}
        className="absolute inset-0 transition-colors hover:bg-neutral-900/25 focus-visible:bg-neutral-900/40 focus-visible:-outline-offset-2"
      />
      <div
        className={cn(
          'pointer-events-none relative flex items-center gap-3 px-3.5 pr-10',
          compact ? 'py-2.5' : 'py-4'
        )}
      >
        <CoinAvatar
          image={coin.image}
          symbol={coin.symbol}
          className={cn(
            'rounded-xl text-lg shadow-[0_6px_18px_-8px_rgba(0,0,0,0.6)] ring-1 ring-white/10',
            hot && 'ring-2 ring-acid/50',
            compact ? 'h-11 w-11' : 'h-16 w-16'
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold tracking-tight">{coin.symbol}</span>
            {coin.isDemo && (
              <span className="rounded border border-neutral-700 px-1 py-px text-[10px] font-medium tracking-wide text-neutral-400">
                DEMO
              </span>
            )}
            <SplitBadge creatorShareBps={coin.creatorShareBps} />
            {!coin.isMigrated && (
              <TaxBadge
                launchedAt={coin.launchedAt}
                isMigrated={coin.isMigrated}
                isDemo={coin.isDemo}
                feePolicyVersion={coin.feePolicyVersion}
                hideWhenClean
              />
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <p className="min-w-0 truncate text-xs text-neutral-300">{coin.name}</p>
            <SocialLinks
              socials={coin.socials}
              source={coin.source}
              className="max-w-full flex-wrap gap-0 [&_a]:pointer-events-auto [&_a]:h-6 [&_a]:w-6"
            />
          </div>
          <p
            className="mt-1 truncate whitespace-nowrap font-mono text-[10px] text-neutral-500"
            suppressHydrationWarning
          >
            {now ? formatAge(new Date(coin.launchedAt * 1000), new Date(now * 1000)) : ' '} ·{' '}
            {market
              ? `Vol ${usd(market.volumeSol)}`
              : coin.isDemo
                ? 'Sample launch'
                : shortenAddress(coin.creator)}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <AnimatedNumber
            value={coin.marketCapSol}
            format={usd}
            title={`${formatReadableNumber(coin.marketCapSol)} SOL`}
            className={cn(
              'font-mono text-[14px] font-semibold tabular transition-colors duration-700',
              flash === 'up' && 'text-emerald',
              flash === 'down' && 'text-rose'
            )}
          />
          <span
            className={cn(
              'inline-flex items-center gap-0.5 font-mono text-[10px] font-medium tabular',
              market?.changePercent === null || !market
                ? 'text-neutral-500'
                : down
                  ? 'text-rose'
                  : 'text-emerald'
            )}
            title={`${coin.isDemo ? 'Simulated' : 'Observed'} price change over recent trades`}
          >
            {market?.changePercent !== null && market?.changePercent !== undefined ? (
              <>
                <span
                  className={cn(
                    'iconify h-2.5 w-2.5',
                    down ? 'ph--arrow-down-right-bold' : 'ph--arrow-up-right-bold'
                  )}
                />
                {Math.abs(market.changePercent).toFixed(1)}%
              </>
            ) : (
              '—'
            )}
            <span className="ml-1 text-[9px] font-normal text-neutral-500">recent</span>
          </span>
          {!coin.isMigrated && (
            <>
              <span
                className={cn(
                  'font-mono text-[10px] tabular',
                  hot ? 'font-semibold text-acid' : 'text-neutral-400'
                )}
              >
                {hot ? `${pct.toFixed(0)}% · almost` : `${pct.toFixed(pct < 10 ? 1 : 0)}% to bond`}
              </span>
              <span
                className={cn(
                  'block h-1 w-20 overflow-hidden rounded-full bg-neutral-850',
                  hot && 'bond-track-hot'
                )}
                aria-hidden
              >
                <BondFill progress={coin.progress} />
              </span>
            </>
          )}
        </div>
      </div>
      <StarButton
        mint={coin.mint}
        revealOnHover
        className="absolute right-2 top-1/2 z-10 -translate-y-1/2"
      />
    </div>
  );
});
CoinCard.displayName = 'CoinCard';
