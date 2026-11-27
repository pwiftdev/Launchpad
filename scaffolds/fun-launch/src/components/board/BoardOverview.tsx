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
      className="holo-border enter relative mb-3 shrink-0 overflow-hidden rounded-3xl"
    >
      {/* Warm light pooling behind the headline */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-28 -top-40 -z-10 h-[26rem] w-[26rem] rounded-full bg-[radial-gradient(circle,rgba(255,110,20,0.30),transparent_65%)] blur-2xl"
      />
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="absolute right-3 top-3 z-10 grid h-8 w-8 place-items-center rounded-full text-neutral-400 ring-1 ring-inset ring-white/10 transition-all duration-200 ease-out hover:bg-white/10 hover:text-foreground"
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand overview' : 'Collapse overview'}
      >
        <span
          aria-hidden="true"
          className={cn(
            'iconify h-4 w-4 transition-transform duration-300 ease-spring ph--caret-up-bold',
            collapsed && 'rotate-180'
          )}
        />
      </button>
      {collapsed ? (
        <div className="flex h-14 items-center gap-3 px-4 pr-14 text-[13px] text-neutral-300">
          <LogoMark small className="h-7 w-6 drop-shadow-[0_4px_10px_rgba(255,102,0,0.4)]" />
          <span className="font-semibold text-foreground">
            {total === undefined ? '—' : count.format(total)}
          </span>
          <span className="-ml-1.5 text-neutral-500">launched</span>
          <span aria-hidden="true" className="h-1 w-1 rounded-full bg-neutral-600" />
          <span className="font-semibold text-primary">
            {bonded === undefined ? '—' : count.format(bonded)}
          </span>
          <span className="-ml-1.5 text-neutral-500">bonded</span>
          <Link
            href="/launch"
            className="btn-holo ml-auto hidden h-9 items-center gap-1.5 px-3.5 text-[12.5px] sm:inline-flex"
          >
            <span className="iconify h-4 w-4 ph--plus-bold" />
            Launch
          </Link>
        </div>
      ) : (
        <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-[minmax(15rem,0.8fr)_minmax(0,2fr)] lg:items-center lg:gap-6 lg:pr-14 2xl:p-6 2xl:pr-14">
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
    <div className="grid min-w-0 gap-4 sm:grid-cols-2 lg:gap-5">
      {/* Both columns stretch to one height: eyebrow, a body that fills, then a footnote */}
      <section aria-label="Launchpad statistics" className="flex min-w-0 flex-col gap-2.5">
        <h2 className="eyebrow">Launchpad</h2>
        {/* Equal rows: every tile matches the tallest one, so both rows line up */}
        <dl className="grid flex-1 auto-rows-fr grid-cols-6 gap-2">
          <Tile
            label="Launched"
            icon="ph--rocket-launch"
            value={total === undefined ? '—' : count.format(total)}
          />
          <Tile
            label="Bonded"
            icon="ph--seal-check"
            value={bonded === undefined ? '—' : count.format(bonded)}
            accent
          />
          <Tile
            label="Pool reserves"
            icon="ph--drop"
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
            icon="ph--chart-line-up"
            value={market.volume === null ? '—' : usd(market.volume)}
            title={market.coverage}
            wide
          />
          <Tile
            label={market.preview ? 'Sample swaps' : 'Swaps · 24h'}
            icon="ph--arrows-left-right"
            value={market.swaps === null ? '—' : count.format(market.swaps)}
            title={market.coverage}
            wide
          />
        </dl>
        <p className="flex items-center gap-1.5 text-[11px] text-neutral-500">
          <span
            aria-hidden
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              market.preview ? 'bg-amber' : 'animate-glow-pulse bg-emerald'
            )}
          />
          {market.preview
            ? 'Simulated swap activity'
            : market.data?.updatedAt
              ? `${market.data.trackedPools} of ${market.data.totalPools} pools sampled`
              : 'Waiting for swap data'}
        </p>
      </section>
      <div className="hidden min-w-0 sm:flex sm:flex-col">
        <SolanaMarketPanel className="flex-1" />
      </div>
    </div>
  );
}

function BoardIntro() {
  return (
    <div className="flex min-w-0 flex-col justify-center">
      <ThesisModal>
        <button
          type="button"
          aria-label={`About ${BRAND.longName}`}
          className="chip w-fit transition-all duration-200 ease-out hover:border-primary/30 hover:bg-primary/10 hover:text-foreground"
        >
          <span aria-hidden="true" className="relative flex h-1.5 w-1.5">
            <span className="absolute inset-0 animate-ping rounded-full bg-primary/70" />
            <span className="relative h-1.5 w-1.5 rounded-full bg-primary" />
          </span>
          The Monero payout launchpad
          <span aria-hidden className="iconify h-3 w-3 text-neutral-500 ph--arrow-up-right" />
        </button>
      </ThesisModal>
      <h1
        aria-label={`${BRAND.headline.top} ${BRAND.headline.bottom}`}
        className="mt-3.5 text-[28px] font-semibold leading-[1.02] tracking-[-0.045em] sm:text-[32px] lg:text-[38px] 2xl:text-[50px]"
      >
        <Decrypt text="Earn from" /> <Decrypt text="every trade." delay={90} />
        <br />
        <Decrypt text="Cash out" delay={180} className="text-holo" />{' '}
        <Decrypt text="in wXMR." delay={270} className="text-holo" />
      </h1>
      <p className="mt-3 hidden max-w-md text-[13.5px] leading-relaxed text-neutral-400 lg:block">
        Every coin splits {pct(SPLIT.beneficiaryBps)} of every trade between its creator and
        holders, locked at launch. Claim in wXMR or SOL. {pct(SCHEDULE.endingFeeBps)} flat, before
        and after bonding.
      </p>
      <div className="mt-5 hidden flex-wrap items-center gap-2 lg:flex">
        <Link
          href="/launch"
          className="btn-holo group inline-flex h-11 shrink-0 items-center gap-2 px-5 text-[13.5px]"
        >
          Launch a coin
          <span
            aria-hidden="true"
            className="iconify h-4 w-4 transition-transform duration-200 ease-spring group-hover:translate-x-0.5 ph--arrow-right-bold"
          />
        </Link>
        <Link
          href="/rules"
          className="btn-glass inline-flex h-11 shrink-0 items-center px-4 text-[13px]"
        >
          How fees work
        </Link>
        <Link
          href="/proof"
          className="group inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl px-3 text-[13px] font-medium text-neutral-400 transition-colors duration-200 hover:text-foreground"
        >
          <span
            aria-hidden="true"
            className="iconify h-4 w-4 text-primary transition-transform duration-200 ease-spring group-hover:scale-110 ph--seal-check-fill"
          />
          See the proof
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
  icon,
  accent,
  wide,
}: {
  label: string;
  value: string;
  detail?: string;
  title?: string;
  icon: string;
  accent?: boolean;
  wide?: boolean;
}) {
  return (
    <div
      title={title}
      className={cn(
        'tile tile-hover flex min-w-0 flex-col px-3.5 py-2.5',
        wide ? 'col-span-3' : 'col-span-2'
      )}
    >
      <dt className="flex items-center gap-1.5 text-[11px] text-neutral-400">
        <span aria-hidden className={cn('iconify h-3.5 w-3.5 text-neutral-500', icon)} />
        <span className="truncate">{label}</span>
      </dt>
      <dd
        className={cn(
          'mt-1.5 truncate font-mono text-[19px] font-semibold leading-none tracking-tight tabular 2xl:text-[23px]',
          accent && 'text-primary'
        )}
      >
        {value}
      </dd>
      {detail && <dd className="mt-1.5 font-mono text-[10.5px] text-neutral-500">{detail}</dd>}
    </div>
  );
}
