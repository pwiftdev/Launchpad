import { cn } from '@/lib/utils';
import { SCHEDULE, pct, splitRows, type FeeMode, type SplitRow } from '@/lib/feeModes';

const TONE: Record<SplitRow['key'], string> = {
  beneficiary: 'bg-signal',
  creator: 'bg-signal/45',
  holders: 'bg-signal',
  house: 'bg-foreground/70',
  buyback: 'bg-rose',
  meteora: 'bg-neutral-700',
};
const EARNERS = new Set<SplitRow['key']>(['beneficiary', 'creator', 'holders']);

/** Where every 1.25% goes: one segmented bar and a legend line per share. */
export const FeeSplit = ({
  mode,
  creatorShareBps,
  className,
  compact,
}: {
  mode: FeeMode;
  /** A Masked coin's locked creator share; leave out to show the 0.60% as one row. */
  creatorShareBps?: number | null;
  className?: string;
  compact?: boolean;
}) => {
  const rows = splitRows(mode, creatorShareBps);
  return (
    <div className={className}>
      <div
        className="flex h-2.5 w-full gap-[3px]"
        role="img"
        aria-label={`Every ${pct(SCHEDULE.endingFeeBps)} trade fee: ${rows
          .map((r) => `${pct(r.bps)} to ${r.label}`)
          .join(', ')}`}
      >
        {rows.map((r) =>
          r.bps > 0 ? (
            <span
              key={r.key}
              className={cn(
                'h-full rounded-full shadow-[inset_0_1px_0_rgba(255,255,255,0.3)] first:rounded-l-full last:rounded-r-full',
                TONE[r.key]
              )}
              style={{ width: `${(r.bps / SCHEDULE.endingFeeBps) * 100}%` }}
            />
          ) : null
        )}
      </div>
      <dl className={cn('mt-3 grid gap-1.5', compact ? 'text-[12px]' : 'text-[13px]')}>
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-2">
            <span className={cn('h-2 w-2 shrink-0 rounded-full', TONE[r.key])} aria-hidden />
            <dt className="text-neutral-400">
              {r.label}
              {r.key === 'holders' && <span className="text-neutral-600"> · pro rata</span>}
              {r.key === 'beneficiary' && mode.beneficiary === 'holders' && (
                <span className="text-neutral-600"> · pro rata, in {mode.payoutSymbol}</span>
              )}
            </dt>
            <dd
              className={cn(
                'ml-auto font-mono tabular',
                EARNERS.has(r.key) ? 'font-semibold text-foreground' : 'text-neutral-400'
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
