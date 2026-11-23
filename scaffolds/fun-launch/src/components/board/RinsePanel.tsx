import type { Coin } from '@/lib/coin';
import { nowSeconds, useNow } from '@/hooks/useNow';
import {
  BASE_FEE_PERCENT,
  LAUNCH_TAX_CLIFF_PERCENT,
  LAUNCH_TAX_STEP_SECONDS,
  LAUNCH_TAX_WINDOW_SECONDS,
} from '@/constants/launch';
import { TAX_STEPS, formatTaxPercent, taxStateAt, hasCurrentTaxSchedule } from '@/lib/launchTax';
import { formatReadableNumber } from '@/lib/format/number';
import { cn } from '@/lib/utils';
import { CoinAvatar } from '../coin/CoinAvatar';
import { CoinLink } from '../coin/CoinLink';
import { BoardPanel } from './BoardPanel';

/** First board column: live platform numbers, coins in the launch-tax window, the schedule. */
export const RinsePanel = ({
  coins,
  className,
}: {
  coins: Coin[] | undefined;
  className?: string;
}) => {
  const now = useNow(250);
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
  const inCurves = list.reduce((a, c) => a + (c.isMigrated ? 0 : c.quoteReserveSol), 0);

  return (
    <BoardPanel
      id="rinse"
      title="Historical launch fees"
      icon="ph--drop-fill"
      iconClassName={rinsing.length ? 'text-rose' : 'text-primary'}
      className={className}
      controls={
        rinsing.length > 0 && (
          <span className="mr-1.5 flex items-center gap-1.5 text-[11px] font-medium text-rose">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose" />
            {rinsing.length} live
          </span>
        )
      }
    >
      <dl className="grid grid-cols-3 border-b border-neutral-850">
        <Stat label="Live" value={coins ? String(live) : '—'} />
        <Stat label="Bonded" value={coins ? String(list.length - live) : '—'} border />
        <Stat
          label="In curves"
          value={coins ? formatReadableNumber(inCurves) : '—'}
          unit="SOL"
          border
        />
      </dl>

      <div className="p-3">
        <p className="eyebrow px-1">Historical tax windows</p>
        {rinsing.length ? (
          <ul className="mt-2 flex flex-col gap-1.5">
            {rinsing.map((c) => (
              <li key={c.mint}>
                <RinsingRow coin={c} now={c.isDemo ? nowSeconds(true) : now!} />
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-2 rounded-lg border border-dashed border-neutral-850 px-3 py-5 text-center">
            <p className="text-xs text-neutral-500">Quiet right now.</p>
            <p className="mt-0.5 text-[11px] text-neutral-600">
              This panel covers historical fee schedules only.
            </p>
          </div>
        )}
      </div>

      <div className="border-t border-neutral-850 p-3">
        <div className="flex items-baseline justify-between px-1">
          <p className="eyebrow">Historical launch tax</p>
          <p className="font-mono text-[10px] text-neutral-600">every {LAUNCH_TAX_STEP_SECONDS}s</p>
        </div>
        <div className="mt-3 flex h-20 items-end gap-1 px-1" aria-hidden>
          {TAX_STEPS.map((s, i) => (
            <div key={s.second} className="group/bar relative flex h-full flex-1 items-end">
              <div
                className={cn(
                  'w-full rounded-sm transition-colors',
                  i === TAX_STEPS.length - 1
                    ? 'bg-emerald/80'
                    : 'bg-rose/70 group-hover/bar:bg-rose'
                )}
                style={{ height: `${Math.max((s.percent / LAUNCH_TAX_CLIFF_PERCENT) * 100, 4)}%` }}
              />
              <span className="pointer-events-none absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-neutral-800 px-1 font-mono text-[10px] text-neutral-100 opacity-0 transition-opacity group-hover/bar:opacity-100">
                {formatTaxPercent(s.percent)}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-1.5 flex justify-between px-1 font-mono text-[10px] text-neutral-500">
          <span className="text-rose">{LAUNCH_TAX_CLIFF_PERCENT}% · 0s</span>
          <span className="text-emerald">
            {LAUNCH_TAX_WINDOW_SECONDS}s · {BASE_FEE_PERCENT}% target
          </span>
        </div>
        <p className="mt-3 px-1 text-[11px] leading-relaxed text-neutral-500">
          Historical coins keep their original fee routing. New launches use Bond it. The burn feed
          shows completed receipts.
        </p>
      </div>
    </BoardPanel>
  );
};

const Stat = ({
  label,
  value,
  unit,
  border,
}: {
  label: string;
  value: string;
  unit?: string;
  border?: boolean;
}) => (
  <div className={cn('px-3.5 py-3', border && 'border-l border-neutral-850')}>
    <dt className="eyebrow">{label}</dt>
    <dd className="mt-0.5 font-mono text-base font-semibold tabular">
      {value}
      {unit && <span className="ml-1 text-[10px] font-normal text-neutral-500">{unit}</span>}
    </dd>
  </div>
);

const RinsingRow = ({ coin, now }: { coin: Coin; now: number }) => {
  const elapsed = now - coin.launchedAt;
  const { percent, nextStepIn } = taxStateAt(elapsed);
  return (
    <CoinLink
      mint={coin.mint}
      className="block rounded-lg border border-rose/25 bg-rose/[0.06] p-2.5 transition-colors hover:border-rose/50"
    >
      <div className="flex items-center gap-2.5">
        <CoinAvatar
          image={coin.image}
          symbol={coin.symbol}
          className="h-8 w-8 rounded-md text-xs"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{coin.symbol}</p>
          <p className="font-mono text-[11px] text-neutral-500">
            {formatReadableNumber(coin.marketCapSol)} SOL
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-lg font-semibold leading-none tabular text-rose">
            {formatTaxPercent(percent)}
          </p>
          <p className="mt-1 font-mono text-[10px] tabular text-neutral-500">
            next {nextStepIn?.toFixed(1)}s
          </p>
        </div>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-neutral-850">
        <div
          className="h-full rounded-full bg-gradient-to-r from-rose to-emerald"
          style={{ width: `${(elapsed / LAUNCH_TAX_WINDOW_SECONDS) * 100}%` }}
        />
      </div>
    </CoinLink>
  );
};
