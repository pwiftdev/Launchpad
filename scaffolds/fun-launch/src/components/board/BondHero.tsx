import Link from 'next/link';
import { useMemo } from 'react';
import type { Coin } from '@/lib/coin';
import { BRAND } from '@/constants/brand';
import { useLocalSetting } from '@/hooks/useLocalSetting';
import { formatUsd, useUsd } from '@/hooks/useUsd';
import { demoMarket, useMarketStats } from '@/hooks/useMarket';
import { useDemoMode } from '@/hooks/useDemoMode';
import { getDemoCoins } from '@/lib/demo';
import { SCHEDULE, pct } from '@/lib/feeModes';
import { LogoMark } from '../brand/Logo';
import { Decrypt } from '../brand/Decrypt';
import { CoinAvatar } from '../coin/CoinAvatar';
import { CoinLink } from '../coin/CoinLink';
import { BondFill } from '../coin/BondingBar';

// Same threshold as the board's "Bonding" column
const BONDING_PROGRESS = 0.25;

/**
 * Top of the board: the promise (your keys, your launches; no KYC), the live bond rate and the
 * coin closest to bonding. Collapses to a slim strip.
 */
export const BondHero = ({ coins }: { coins: Coin[] | undefined }) => {
  const [collapsed, setCollapsed] = useLocalSetting('mskd.heroCollapsed', false);
  const { usd, price } = useUsd();
  const market = useLaunchpadMarket(coins);
  const stats = useMemo(() => {
    const list = coins ?? [];
    const bonded = list.filter((c) => c.isMigrated).length;
    const bonding = list.filter((c) => !c.isMigrated && c.progress >= BONDING_PROGRESS).length;
    const next = list
      .filter((c) => !c.isMigrated)
      .reduce<Coin | null>((best, c) => (!best || c.progress > best.progress ? c : best), null);
    return { total: list.length, bonded, bonding, rate: list.length ? bonded / list.length : 0, next };
  }, [coins]);
  const loading = !coins;

  if (collapsed)
    return (
      <div className="glass mb-3 flex h-12 shrink-0 items-center gap-3 rounded-2xl px-3">
        <LogoMark small className="h-6 w-5" />
        <p className="hidden truncate text-[13px] font-semibold tracking-tight sm:block">
          {BRAND.headline.top} <span className="text-holo">{BRAND.headline.bottom}</span>
        </p>
        <span className="hidden h-4 w-px bg-neutral-800 sm:block" />
        <span className="text-xs text-neutral-500">
          Bond rate{' '}
          <b className="font-mono font-semibold text-foreground">
            {loading ? '…' : `${(stats.rate * 100).toFixed(1)}%`}
          </b>
        </span>
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-900 hover:text-foreground"
          aria-label="Expand banner"
        >
          <span className="iconify h-4 w-4 ph--caret-down" />
        </button>
      </div>
    );

  return (
    <section
      aria-label={BRAND.longName}
      className="holo-border relative mb-3 shrink-0 overflow-hidden bg-panel"
    >
      <button
        type="button"
        onClick={() => setCollapsed(true)}
        className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-md text-neutral-600 transition-colors hover:bg-neutral-900 hover:text-foreground"
        aria-label="Collapse banner"
      >
        <span className="iconify h-4 w-4 ph--caret-up" />
      </button>

      <div className="relative grid gap-6 px-5 py-6 sm:px-7 sm:py-7 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)_minmax(0,20rem)] lg:gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,28rem)_minmax(0,22rem)]">
        {/* Promise */}
        <div className="flex min-w-0 items-center">
          <div className="min-w-0">
            <p className="flex items-center gap-2 font-term text-[11px] uppercase tracking-[0.14em] text-neutral-500">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inset-0 animate-ping rounded-full bg-signal opacity-60" />
                <span className="relative h-1.5 w-1.5 rounded-full bg-signal" />
              </span>
              Privacy-first launchpad
            </p>
            <h1
              aria-label={`${BRAND.headline.top} ${BRAND.headline.bottom}`}
              className="mt-4 font-display text-[28px] uppercase leading-[1.05] sm:text-[36px] xl:text-[44px]"
            >
              <Decrypt text={BRAND.headline.top} />
              <br />
              <Decrypt text={BRAND.headline.bottom} delay={180} className="text-holo" />
            </h1>
            <p className="mt-3 max-w-md text-[14px] leading-relaxed text-neutral-400">
              Connect any wallet and launch. Nothing to sign up for, nothing to verify.{' '}
              {pct(SCHEDULE.endingFeeBps)} flat, before and after bonding.
            </p>
            <div className="mt-5 flex items-center gap-2">
              <Link
                href="/launch"
                className="btn-holo inline-flex h-10 shrink-0 items-center gap-2 rounded-lg px-4 text-[13px]"
              >
                Launch a coin
                <span className="iconify h-4 w-4 ph--arrow-right" />
              </Link>
              <Link
                href="/rules"
                className="inline-flex h-10 shrink-0 items-center rounded-lg px-3.5 text-[13px] font-medium text-neutral-400 transition-colors hover:bg-neutral-900 hover:text-foreground"
              >
                How fees work
              </Link>
            </div>
            <p className="mt-5 font-term text-[10px] uppercase tracking-[0.14em] text-neutral-600">
              kyc <span className="text-neutral-400">none</span> · accounts{' '}
              <span className="text-neutral-400">none</span> · keys{' '}
              <span className="text-acid">yours</span>
            </p>
          </div>
        </div>

        {/* Launchpad stats */}
        <dl className="grid min-w-0 grid-cols-2 gap-px self-center border border-white/[0.08] bg-white/[0.08] sm:grid-cols-3">
          <Tile label="Launched" value={loading ? '…' : String(stats.total)} />
          <Tile label="Bonding" value={loading ? '…' : String(stats.bonding)} />
          <Tile label="Bonded" value={loading ? '…' : String(stats.bonded)} accent />
          <Tile label={market.preview ? 'Sample vol.' : 'Recent vol.'} value={market.volume === null ? '—' : usd(market.volume)} />
          <Tile label={market.preview ? 'Sample swaps' : 'Swaps'} value={market.trades === null ? '—' : count.format(market.trades)} />
          <Tile label="In curves" value={market.liquidity === null ? '…' : usd(market.liquidity)} />
          <Tile label="SOL" value={price ? formatUsd(price) : '…'} className="col-span-2 sm:col-span-3" inline />
        </dl>

        {/* Live state */}
        <div className="flex min-w-0 flex-col justify-center gap-4 border-t border-neutral-850 pt-5 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="eyebrow">Bond rate</p>
              <p className="mt-2 font-pixel text-[36px] leading-none tabular">
                {loading ? '…' : `${(stats.rate * 100).toFixed(stats.rate < 0.1 ? 1 : 0)}%`}
              </p>
            </div>
            <p className="text-right text-[11px] leading-snug text-neutral-500">
              of launches
              <br />
              made it to DAMM v2
            </p>
          </div>
          <div className="h-1.5 overflow-hidden bg-white/[0.06]">
            <div
              className="bond-fill h-full bg-signal transition-[width] duration-1000"
              style={{ width: `${Math.max(stats.rate * 100, stats.rate > 0 ? 2 : 0)}%` }}
            />
          </div>
          {stats.next ? (
            <CoinLink
              mint={stats.next.mint}
              aria-label={`Next to bond: $${stats.next.symbol}`}
              className="group -mx-2 flex items-center gap-3 px-2 py-2 transition-colors hover:bg-white/[0.05]"
            >
              <CoinAvatar
                image={stats.next.image}
                symbol={stats.next.symbol}
                className="h-9 w-9 rounded-lg text-xs"
              />
              <div className="min-w-0 flex-1">
                <p className="flex items-baseline gap-2">
                  <span className="truncate text-[13px] font-semibold">${stats.next.symbol}</span>
                  <span className="text-[11px] text-neutral-500">next to bond</span>
                </p>
                <div className="mt-1.5 h-1 overflow-hidden bg-white/[0.06]">
                  <BondFill progress={stats.next.progress} />
                </div>
              </div>
              <div className="text-right">
                <p className="font-mono text-[13px] font-semibold tabular">
                  {(stats.next.progress * 100).toFixed(1)}%
                </p>
                <p className="font-mono text-[11px] text-neutral-500 tabular">
                  {usd(stats.next.marketCapSol)}
                </p>
              </div>
            </CoinLink>
          ) : (
            <p className="text-[13px] text-neutral-500">
              {loading ? 'Reading the curves…' : 'Nothing on a curve yet. Be the first.'}
            </p>
          )}
        </div>
      </div>
    </section>
  );
};

const count = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Volume, swaps and curve liquidity: the same sources as the status bar. */
function useLaunchpadMarket(coins: Coin[] | undefined) {
  const { visible: preview } = useDemoMode();
  const { data } = useMarketStats();
  return useMemo(() => {
    const samples = preview ? getDemoCoins().map(demoMarket) : [];
    const volume = preview
      ? samples.reduce((sum, t) => sum + t.volumeSol, 0)
      : data?.trackedPools
        ? data.volumeSol
        : null;
    const trades = preview
      ? samples.reduce((sum, t) => sum + t.trades, 0)
      : data?.trackedPools
        ? data.trades
        : null;
    const liquidity = coins
      ? coins.reduce((sum, c) => sum + (c.isMigrated ? 0 : c.quoteReserveSol), 0)
      : null;
    return { preview, volume, trades, liquidity };
  }, [preview, data, coins]);
}

const Tile = ({
  label,
  value,
  accent,
  inline,
  className = '',
}: {
  label: string;
  value: string;
  accent?: boolean;
  inline?: boolean;
  className?: string;
}) => (
  <div
    className={`bg-panel px-3.5 py-3 ${inline ? 'flex items-baseline justify-between' : ''} ${className}`}
  >
    <dt className="font-term text-[10px] uppercase tracking-[0.12em] text-neutral-500">{label}</dt>
    <dd className={`${inline ? '' : 'mt-1.5'} font-pixel text-[17px] leading-none tabular ${accent ? 'text-acid' : ''}`}>
      {value}
    </dd>
  </div>
);
