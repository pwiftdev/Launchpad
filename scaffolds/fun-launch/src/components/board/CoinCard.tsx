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
import { MskdV1Badge } from '../coin/MskdV1Badge';

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
  const prices = market?.points;
  const down = (market?.changePercent ?? (prices?.at(-1) ?? 0) - (prices?.[0] ?? 0)) < 0;
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
        'coin-row group relative isolate mb-1.5 overflow-hidden rounded-2xl border border-transparent transition-[transform,border-color,box-shadow] duration-200 ease-out last:mb-0',
        'hover:-translate-y-px hover:border-white/[0.09] hover:bg-gradient-to-b hover:from-white/[0.06] hover:to-white/[0.02] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_16px_34px_-20px_rgba(0,0,0,0.95)]',
        isNew && 'animate-in fade-in slide-in-from-top-3 zoom-in-95 duration-500',
        flash === 'up' && 'row-flash-up',
        flash === 'down' && 'row-flash-down',
        sniping && 'snipe-sheen'
      )}
    >
      {market && (
        <PriceBackdrop
          points={market.points}
          down={down}
          className="absolute -right-2 bottom-0 top-3 -z-10 h-[calc(100%-0.75rem)] w-[60%] opacity-25 transition-opacity duration-300 [mask-image:linear-gradient(90deg,transparent,#000_45%)] group-hover:opacity-50"
        />
      )}
      <CoinLink
        mint={coin.mint}
        aria-label={`${coin.name} ($${coin.symbol})`}
        className="absolute inset-0 rounded-2xl focus-visible:-outline-offset-2"
      />
      <div
        className={cn(
          'pointer-events-none relative flex items-center gap-3.5 pl-2.5 pr-10',
          compact ? 'py-2' : 'py-3'
        )}
      >
        <CoinAvatar
          image={coin.image}
          symbol={coin.symbol}
          className={cn(
            'rounded-2xl text-lg shadow-[0_10px_22px_-10px_rgba(0,0,0,0.9)] transition-transform duration-300 ease-spring group-hover:-rotate-2 group-hover:scale-[1.04]',
            hot && 'shadow-[0_0_22px_-4px_rgba(255,102,0,0.6)] ring-2 ring-primary/60',
            compact ? 'h-11 w-11 rounded-xl' : 'h-[60px] w-[60px]'
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[15px] font-semibold tracking-tight">{coin.symbol}</span>
            {coin.isDemo && (
              <span className="rounded-full bg-white/[0.06] px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider text-neutral-400 ring-1 ring-inset ring-white/[0.08]">
                Demo
              </span>
            )}
            <SplitBadge creatorShareBps={coin.creatorShareBps} />
            <MskdV1Badge coin={coin} />
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
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <p className="min-w-0 truncate text-[12.5px] text-neutral-300">{coin.name}</p>
            {!compact && (
              <SocialLinks
                socials={coin.socials}
                source={coin.source}
                className="max-w-full flex-wrap gap-0 [&_a]:pointer-events-auto [&_a]:h-6 [&_a]:w-6"
              />
            )}
          </div>
          <p
            className="mt-0.5 truncate whitespace-nowrap font-mono text-[10.5px] text-neutral-500"
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
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <AnimatedNumber
            value={coin.marketCapSol}
            format={usd}
            title={`${formatReadableNumber(coin.marketCapSol)} SOL`}
            className={cn(
              'font-mono text-[15px] font-semibold tabular tracking-tight transition-colors duration-500',
              flash === 'up' && 'text-emerald',
              flash === 'down' && 'text-rose'
            )}
          />
          <span
            className={cn(
              'inline-flex items-center gap-0.5 rounded-full px-1.5 py-px font-mono text-[10.5px] font-semibold tabular',
              market?.changePercent === null || !market
                ? 'text-neutral-500'
                : down
                  ? 'bg-rose/10 text-rose'
                  : 'bg-emerald/10 text-emerald'
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
          </span>
          {!coin.isMigrated && (
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  'font-mono text-[10px] tabular',
                  hot ? 'font-semibold text-primary' : 'text-neutral-500'
                )}
              >
                {pct.toFixed(pct < 10 && !hot ? 1 : 0)}%
              </span>
              <span
                className={cn(
                  'block h-1.5 w-16 overflow-hidden rounded-full bg-black/45 shadow-[inset_0_1px_2px_rgba(0,0,0,0.6)] ring-1 ring-inset ring-white/[0.05]',
                  hot && 'bond-track-hot'
                )}
                title={hot ? 'Almost bonded' : 'Progress to bonding'}
                aria-hidden
              >
                <BondFill progress={coin.progress} />
              </span>
            </span>
          )}
        </div>
      </div>
      <StarButton
        mint={coin.mint}
        revealOnHover
        className="absolute right-1.5 top-1/2 z-10 -translate-y-1/2"
      />
    </div>
  );
});
CoinCard.displayName = 'CoinCard';
