import { useNow } from '@/hooks/useNow';
import {
  BASE_FEE_PERCENT,
  LAUNCH_TAX_CLIFF_PERCENT,
  LAUNCH_TAX_STEP_SECONDS,
  LAUNCH_TAX_WINDOW_SECONDS,
} from '@/constants/launch';
import { formatTaxPercent, taxStateAt, hasCurrentTaxSchedule } from '@/lib/launchTax';
import type { Coin } from '@/lib/coin';
import { bondFeeDisplay } from '@/lib/bondFeeDisplay';
import { cn } from '@/lib/utils';

/** Live launch tax as one slim strip: % right now, seconds to the next step, green at 1.25%. */
export const TaxBanner = ({
  launchedAt,
  isDemo = false,
  isMigrated = false,
  feePolicyVersion,
  className,
}: {
  launchedAt: number;
  isDemo?: boolean;
  isMigrated?: boolean;
  feePolicyVersion?: Coin['feePolicyVersion'];
  className?: string;
}) => {
  const now = useNow(100, isDemo);
  const bond = bondFeeDisplay({ feePolicyVersion, isMigrated });
  if (bond)
    return (
      <section
        aria-label="Trading fee"
        title={bond.title}
        className={cn('flex items-center justify-between gap-3 px-4 py-2.5', className)}
      >
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
          {isMigrated ? 'After bonding' : '99% launch slot · then'}
        </span>
        <span className="font-mono text-sm text-emerald">{bond.label}</span>
      </section>
    );
  if (!hasCurrentTaxSchedule({ isDemo, feePolicyVersion }))
    return (
      <section
        aria-label="Trading fee"
        className={cn('flex items-center justify-between gap-3 px-4 py-2.5', className)}
      >
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
          {feePolicyVersion === 'legacy-devnet' ? 'Legacy fee schedule' : 'Trading fee'}
        </span>
        <span
          className="text-[11px] text-neutral-400"
          title="Its original on-chain configuration determines the fee."
        >
          See the live quote
        </span>
      </section>
    );
  const elapsed = now === null ? 0 : now - launchedAt;
  const { percent, nextStepIn, isClean } = taxStateAt(elapsed, isMigrated);
  const windowProgress = isMigrated
    ? 1
    : Math.min(Math.max(elapsed / LAUNCH_TAX_WINDOW_SECONDS, 0), 1);
  const stepProgress = nextStepIn === null ? 1 : 1 - nextStepIn / LAUNCH_TAX_STEP_SECONDS;

  return (
    <section
      aria-label="Snipe tax"
      title={`Starting tax: ${LAUNCH_TAX_CLIFF_PERCENT}%, reducing toward ${BASE_FEE_PERCENT}% over up to ${LAUNCH_TAX_WINDOW_SECONDS}s or graduation. On-chain rounding affects the exact total.`}
      className={cn('px-4 py-2.5 transition-colors', !isClean && 'bg-rose/[0.07]', className)}
    >
      <div className="flex items-center justify-between gap-3">
        <span
          className={cn(
            'text-[10px] font-semibold uppercase tracking-wider',
            isClean ? 'text-neutral-500' : 'text-rose'
          )}
        >
          {isClean ? 'Snipe tax over' : 'Snipe tax'}
        </span>
        <span className="flex items-baseline gap-2">
          {!isClean && nextStepIn !== null && (
            <span className="font-mono text-[10px] tabular text-rose/80">
              next step {nextStepIn.toFixed(1)}s
            </span>
          )}
          <span
            className={cn(
              'font-mono text-sm font-semibold tabular',
              isClean ? 'text-emerald' : 'text-rose'
            )}
            aria-live="polite"
          >
            {now === null ? '—' : formatTaxPercent(percent)}
          </span>
        </span>
      </div>
      {!isClean && (
        <div className="mt-2 flex gap-0.5" aria-hidden>
          {Array.from({ length: 9 }, (_, i) => {
            const fill = Math.min(Math.max(windowProgress * 9 - i, 0), 1);
            const current = i === Math.floor(windowProgress * 9);
            return (
              <span key={i} className="h-0.5 flex-1 overflow-hidden rounded-full bg-neutral-850">
                <span
                  className="block h-full rounded-full bg-rose"
                  style={{ width: `${(current ? stepProgress : fill) * 100}%` }}
                />
              </span>
            );
          })}
        </div>
      )}
      <span className="sr-only">
        {isClean ? 'Scheduled base fee' : 'Scheduled snipe tax'}, see the live quote.
      </span>
    </section>
  );
};
