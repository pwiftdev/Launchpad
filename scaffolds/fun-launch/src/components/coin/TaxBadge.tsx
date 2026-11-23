import { useNow } from '@/hooks/useNow';
import { formatTaxPercent, taxStateAt, hasCurrentTaxSchedule } from '@/lib/launchTax';
import type { Coin } from '@/lib/coin';
import { bondFeeDisplay } from '@/lib/bondFeeDisplay';
import { cn } from '@/lib/utils';

type TaxBadgeProps = {
  launchedAt: number;
  isMigrated?: boolean;
  isDemo?: boolean;
  feePolicyVersion?: Coin['feePolicyVersion'];
  /** Render nothing once the tax window is over (keeps busy lists calm) */
  hideWhenClean?: boolean;
  className?: string;
};

/** Live snipe-tax pill: red while snipers are paying up, green once clean. */
export const TaxBadge = ({
  launchedAt,
  isMigrated = false,
  isDemo = false,
  feePolicyVersion,
  hideWhenClean,
  className,
}: TaxBadgeProps) => {
  const now = useNow(500, isDemo);
  const bond = bondFeeDisplay({ feePolicyVersion, isMigrated });
  if (bond)
    return hideWhenClean ? null : (
      <span
        className={cn(
          'rounded bg-emerald/10 px-1.5 py-0.5 font-mono text-[11px] text-emerald',
          className
        )}
        title={bond.title}
      >
        {bond.label}
      </span>
    );
  if (!hasCurrentTaxSchedule({ isDemo, feePolicyVersion }))
    // Busy lists stay calm: the coin page still explains the original fee configuration
    return hideWhenClean ? null : (
      <span
        className={cn(
          'inline-flex rounded bg-neutral-850 px-1.5 py-0.5 text-[11px] text-neutral-400',
          className
        )}
        title="This coin uses its original fee configuration. Check the live quote for its trading fee."
      >
        {feePolicyVersion === 'legacy-devnet' ? 'Legacy fees' : 'See quote'}
      </span>
    );
  if (now === null) return null;
  const { percent, nextStepIn, isClean } = taxStateAt(now - launchedAt, isMigrated);
  if (isClean && hideWhenClean) return null;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] font-medium tabular',
        isClean ? 'bg-emerald/10 text-emerald' : 'bg-rose/15 text-rose',
        className
      )}
      title={
        isClean
          ? 'Scheduled base fee approximately 1.25%. Check the live quote for the exact trading fee.'
          : 'Scheduled snipe tax. Check the quote for the total fee.'
      }
    >
      {!isClean && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose" />}
      {isClean
        ? isMigrated
          ? '1.25%'
          : '≈1.25%'
        : `${formatTaxPercent(percent)} · ${Math.ceil(nextStepIn ?? 0)}s`}
    </span>
  );
};
