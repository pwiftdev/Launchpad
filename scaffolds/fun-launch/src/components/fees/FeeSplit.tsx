import { cn } from '@/lib/utils';
import { SCHEDULE, pct, splitRows, type FeeMode } from '@/lib/feeModes';

const TONE = {
  beneficiary: 'bg-signal',
  house: 'bg-foreground/70',
  meteora: 'bg-neutral-700',
} as const;
const DOT = {
  beneficiary: 'bg-signal',
  house: 'bg-foreground/70',
  meteora: 'bg-neutral-600',
} as const;

/** Where every 1.25% goes: one segmented bar and a three-line legend. */
export const FeeSplit = ({
  mode,
  className,
  compact,
}: {
  mode: FeeMode;
  className?: string;
  compact?: boolean;
}) => {
  const rows = splitRows(mode);
  return (
    <div className={className}>
      <div
        className="flex h-1.5 w-full gap-[2px]"
        role="img"
        aria-label={`Every ${pct(SCHEDULE.endingFeeBps)} trade fee: ${rows
          .map((r) => `${pct(r.bps)} to ${r.label}`)
          .join(', ')}`}
      >
        {rows.map((r) => (
          <span
            key={r.key}
            className={cn('h-full', TONE[r.key])}
            style={{ width: `${(r.bps / SCHEDULE.endingFeeBps) * 100}%` }}
          />
        ))}
      </div>
      <dl className={cn('mt-2.5 grid gap-1', compact ? 'text-[11px]' : 'text-xs')}>
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-2">
            <span className={cn('h-1.5 w-1.5 shrink-0', DOT[r.key])} aria-hidden />
            <dt className="text-neutral-400">
              {r.label}
              {r.key === 'beneficiary' && mode.beneficiary === 'holders' && (
                <span className="text-neutral-600"> · pro rata, in {mode.payoutSymbol}</span>
              )}
            </dt>
            <dd
              className={cn(
                'ml-auto font-mono tabular',
                r.key === 'beneficiary' ? 'font-semibold text-foreground' : 'text-neutral-400'
              )}
            >
              {pct(r.bps)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
};
