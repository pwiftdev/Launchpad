import Link from 'next/link';
import type { Coin } from '@/lib/coin';
import { BRAND } from '@/constants/brand';
import { useLocalSetting } from '@/hooks/useLocalSetting';
import { useLaunchpadMarket } from '@/hooks/useMarket';
import { useUsd } from '@/hooks/useUsd';
import { SCHEDULE, SPLIT, pct } from '@/lib/feeModes';
import { formatReadableNumber } from '@/lib/format/number';
import { POOL_RESERVES_DESCRIPTION } from '@/lib/market';
import { cn } from '@/lib/utils';
import { LogoMark } from '../brand/Logo';
import { Decrypt } from '../brand/Decrypt';
import { ThesisModal } from '../brand/ThesisModal';
import { SolanaMarketPanel } from './SolanaMarketPanel';

const count = new Intl.NumberFormat('en-US');

export function BoardOverview({ coins }: { coins: Coin[] | undefined }) {
  const [collapsed, setCollapsed] = useLocalSetting('mskd.heroCollapsed', false);
  const total = coins?.length;
  const bonded = coins?.filter((coin) => coin.isMigrated).length;

  return (
    <section
      aria-label="Launchpad overview"
      className="holo-border relative mb-3 shrink-0 overflow-hidden bg-panel"
    >
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="absolute right-1.5 top-1.5 z-10 grid h-9 w-9 place-items-center text-neutral-400 transition-colors hover:bg-neutral-900 hover:text-foreground"
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand overview' : 'Collapse overview'}
      >
        <span
          aria-hidden="true"
          className={cn('iconify h-4 w-4', collapsed ? 'ph--caret-down' : 'ph--caret-up')}
        />
      </button>
      {collapsed ? (
        <div className="flex h-12 items-center gap-2.5 px-3 pr-12 font-term text-xs text-neutral-400">
          <LogoMark small className="h-6 w-5" />
          <span>{total === undefined ? '—' : count.format(total)} launched</span>
          <span aria-hidden="true">·</span>
          <span>{bonded === undefined ? '—' : count.format(bonded)} bonded</span>
        </div>
      ) : (
        <div className="grid gap-4 px-4 py-4 sm:px-5 lg:grid-cols-[minmax(12rem,0.72fr)_minmax(0,2fr)] lg:items-center lg:gap-6 lg:py-5 lg:pr-12 2xl:px-7 2xl:pr-12">
          <BoardIntro />
          <OverviewStats coins={coins} total={total} bonded={bonded} />
        </div>
      )}
    </section>
  );
}

function OverviewStats({
  coins,
  total,
  bonded,
}: {
  coins: Coin[] | undefined;
  total?: number;
  bonded?: number;
}) {
  const market = useLaunchpadMarket(coins);
  const { usd, price } = useUsd();
  return (
    <div className="grid min-w-0 auto-rows-fr gap-4 sm:grid-cols-2 lg:gap-5">
      <section aria-label="Launchpad statistics" className="flex min-w-0 flex-col gap-2">
        <h2 className="eyebrow text-neutral-300">Launchpad</h2>
        <div className="flex flex-1 flex-col border border-white/[0.08]">
          <dl className="grid flex-1 auto-rows-fr grid-cols-6 gap-px bg-white/[0.08]">
            <Tile label="Launched" value={total === undefined ? '—' : count.format(total)} />
            <Tile label="Bonded" value={bonded === undefined ? '—' : count.format(bonded)} accent />
            <Tile
              label="Pool reserves"
              value={market.liquidity === undefined ? '—' : usd(market.liquidity)}
              detail={
                price && market.liquidity !== undefined
                  ? `${formatReadableNumber(market.liquidity)} SOL eq.`
                  : undefined
              }
              title={POOL_RESERVES_DESCRIPTION}
            />
            <Tile
              label={market.preview ? 'Sample volume' : 'Volume · 24h'}
              value={market.volume === null ? '—' : usd(market.volume)}
              title={market.coverage}
              wide
            />
            <Tile
              label={market.preview ? 'Sample swaps' : 'Swaps · 24h'}
              value={market.swaps === null ? '—' : count.format(market.swaps)}
              title={market.coverage}
              wide
            />
          </dl>
          <p className="border-t border-white/[0.08] px-2 py-1.5 text-[11px] text-neutral-400 sm:px-2.5">
            {market.preview
              ? 'Simulated swap activity'
              : market.data?.updatedAt
                ? `${market.data.trackedPools} of ${market.data.totalPools} pools sampled`
                : 'Waiting for swap data'}
          </p>
        </div>
      </section>
      <SolanaMarketPanel />
    </div>
  );
}

function BoardIntro() {
  return (
    <div className="min-w-0">
      <ThesisModal>
        <button
          type="button"
          aria-label={`About ${BRAND.longName}`}
          className="flex items-center gap-2 font-term text-[11px] uppercase tracking-[0.14em] text-neutral-500 transition-colors hover:text-foreground focus-visible:text-foreground"
        >
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-signal" />
          The Monero payout launchpad
        </button>
      </ThesisModal>
      <h1
        aria-label={`${BRAND.headline.top} ${BRAND.headline.bottom}`}
        className="mt-1.5 font-display text-[21px] uppercase leading-[1.1] sm:text-[24px] lg:mt-3 lg:text-[30px] 2xl:text-[40px]"
      >
        {/* The headline is long for the narrow hero column: two short lines per phrase. */}
        <Decrypt text="Earn from" /> <Decrypt text="every trade." delay={90} />
        <br className="hidden lg:block" />{' '}
        <Decrypt text="Cash out" delay={180} className="text-holo" />{' '}
        <Decrypt text="in Monero." delay={270} className="text-holo" />
      </h1>
      <p className="mt-2 hidden max-w-md text-[13px] leading-relaxed text-neutral-400 lg:block">
        Every coin splits {pct(SPLIT.beneficiaryBps)} of every trade between its creator and
        holders, locked at launch. Claim in native XMR or SOL. {pct(SCHEDULE.endingFeeBps)} flat,
        before and after bonding.
      </p>
      <div className="mt-3 hidden flex-wrap items-center gap-2 lg:flex">
        <Link
          href="/launch"
          className="btn-holo inline-flex h-9 shrink-0 items-center gap-2 px-3 text-xs"
        >
          Launch a coin
          <span aria-hidden="true" className="iconify h-4 w-4 ph--arrow-right" />
        </Link>
        <Link
          href="/rules"
          className="inline-flex h-9 shrink-0 items-center px-2 text-xs font-medium text-neutral-400 transition-colors hover:bg-neutral-900 hover:text-foreground"
        >
          How fees work
        </Link>
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  detail,
  title,
  accent,
  wide,
}: {
  label: string;
  value: string;
  detail?: string;
  title?: string;
  accent?: boolean;
  wide?: boolean;
}) {
  return (
    <div
      title={title}
      className={cn('min-w-0 bg-panel px-2 py-3 sm:px-2.5', wide ? 'col-span-3' : 'col-span-2')}
    >
      <dt className="font-term text-[9px] uppercase tracking-wider text-neutral-400 sm:text-[10px]">
        {label}
      </dt>
      <dd
        className={cn(
          'mt-1.5 break-words font-pixel text-[15px] leading-none tabular',
          accent && 'text-acid'
        )}
      >
        {value}
      </dd>
      {detail && <dd className="mt-1 font-mono text-[10px] text-neutral-400">{detail}</dd>}
    </div>
  );
}
