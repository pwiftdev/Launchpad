import Link from 'next/link';
import type { Coin } from '@/lib/coin';
import { nowSeconds, useNow } from '@/hooks/useNow';
import {
  BASE_FEE_PERCENT,
  DEV_BUY_MAX_PERCENT_OF_SUPPLY,
  LAUNCH_TAX_CLIFF_PERCENT,
  LAUNCH_TAX_WINDOW_SECONDS,
} from '@/constants/launch';
import { TAX_STEPS, formatTaxPercent, hasCurrentTaxSchedule } from '@/lib/launchTax';
import { formatReadableNumber } from '@/lib/format/number';
import { cn } from '@/lib/utils';
import { buttonVariants } from '../ui/button';
import { CoinAvatar } from '../coin/CoinAvatar';
import { TaxBadge } from '../coin/TaxBadge';
import { CoinLink } from '../coin/CoinLink';

/** Left dashboard: live platform stats, launch CTA, coins in the rinse right now, the tax schedule. */
export const DashboardSidebar = ({
  coins,
  className,
}: {
  coins: Coin[] | undefined;
  className?: string;
}) => {
  const now = useNow(1000);
  const list = coins ?? [];
  const rinsing =
    now === null
      ? []
      : list.filter(
          (c) =>
            !c.isMigrated &&
            hasCurrentTaxSchedule(c) &&
            (c.isDemo ? nowSeconds(true) : now) - c.launchedAt < LAUNCH_TAX_WINDOW_SECONDS
        );
  const live = list.filter((c) => !c.isMigrated).length;
  const bonded = list.length - live;
  const inCurves = list.reduce((a, c) => a + (c.isMigrated ? 0 : c.quoteReserveSol), 0);

  return (
    <aside className={cn('flex flex-col gap-3', className)}>
      <section className="surface p-4" aria-label="Platform stats">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Stat label="Live coins" value={coins ? String(live) : '—'} />
          <Stat
            label="Legacy tax window"
            value={coins ? String(rinsing.length) : '—'}
            tone={rinsing.length ? 'text-rose' : undefined}
            pulse={rinsing.length > 0}
          />
          <Stat label="Bonded" value={coins ? String(bonded) : '—'} />
          <Stat label="SOL in curves" value={coins ? formatReadableNumber(inCurves) : '—'} />
        </dl>
      </section>

      <section className="surface p-4 max-lg:hidden">
        <Link href="/launch" className={buttonVariants({ className: 'w-full' })}>
          <span className="iconify h-4 w-4 ph--plus-bold" />
          Launch a coin
        </Link>
        <p className="mt-3 text-xs leading-relaxed text-neutral-500">
          New launches use Bond it.: 99% in the launch slot, then 1.25% on the curve and 1% after
          bonding. Optional paid first buy: max {DEV_BUY_MAX_PERCENT_OF_SUPPLY}%.
        </p>
      </section>

      <section
        className={cn('surface p-4', !rinsing.length && 'max-lg:hidden')}
        aria-label="Historical launch fees"
      >
        <div className="mb-2 flex items-center justify-between">
          <span className="eyebrow">Historical tax windows</span>
          {rinsing.length > 0 && (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose" />
          )}
        </div>
        {rinsing.length ? (
          <ul className="-mx-1.5 flex flex-col">
            {rinsing.map((c) => (
              <li key={c.mint}>
                <CoinLink
                  mint={c.mint}
                  className="flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-neutral-900"
                >
                  <CoinAvatar
                    image={c.image}
                    symbol={c.symbol}
                    className="h-6 w-6 rounded text-[10px]"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">${c.symbol}</span>
                  <TaxBadge
                    launchedAt={c.launchedAt}
                    isMigrated={c.isMigrated}
                    isDemo={c.isDemo}
                    feePolicyVersion={c.feePolicyVersion}
                  />
                </CoinLink>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-neutral-500">
            No historical coins in their launch-tax window.
          </p>
        )}
      </section>

      <section className="surface p-4 max-lg:hidden" aria-label="Historical fee schedule">
        <span className="eyebrow">Historical fee schedule</span>
        <div className="mt-3 flex h-16 items-end gap-1" aria-hidden>
          {TAX_STEPS.map((s, i) => (
            <div
              key={s.second}
              className={cn(
                'flex-1 rounded-sm',
                i === TAX_STEPS.length - 1 ? 'bg-emerald/70' : 'bg-rose/70'
              )}
              style={{
                height: `${Math.max((s.percent / LAUNCH_TAX_CLIFF_PERCENT) * 100, 4)}%`,
                opacity: 1 - i * 0.06,
              }}
              title={`${s.second}s: ${formatTaxPercent(s.percent)}`}
            />
          ))}
        </div>
        <div className="mt-1.5 flex justify-between font-mono text-[10px] text-neutral-500">
          <span>0s · {LAUNCH_TAX_CLIFF_PERCENT}%</span>
          <span>
            {LAUNCH_TAX_WINDOW_SECONDS}s · {BASE_FEE_PERCENT}% target
          </span>
        </div>
        <Link
          href="/rules"
          className="mt-3 inline-block text-xs text-neutral-400 hover:text-foreground"
        >
          How it works →
        </Link>
      </section>
    </aside>
  );
};

const Stat = ({
  label,
  value,
  tone,
  pulse,
}: {
  label: string;
  value: string;
  tone?: string;
  pulse?: boolean;
}) => (
  <div>
    <dt className="eyebrow">{label}</dt>
    <dd
      className={cn(
        'mt-0.5 flex items-center gap-1.5 font-mono text-lg font-semibold tabular',
        tone
      )}
    >
      {value}
      {pulse && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose" />}
    </dd>
  </div>
);
