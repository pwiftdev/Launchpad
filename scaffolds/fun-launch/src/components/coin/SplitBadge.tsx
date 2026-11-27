import { SPLIT, pct } from '@/lib/feeModes';
import { cn } from '@/lib/utils';

/** A Masked coin's locked split of the 0.60%: how much of every trade goes to its holders. */
export const SplitBadge = ({
  creatorShareBps,
  className,
}: {
  creatorShareBps?: number | null;
  className?: string;
}) => {
  if (creatorShareBps === undefined || creatorShareBps === null) return null;
  const holders = 100 - creatorShareBps / 100;
  return (
    <span
      className={cn(
        'rounded-full bg-white/[0.06] px-1.5 py-px font-mono text-[10px] font-medium text-neutral-300 ring-1 ring-inset ring-white/[0.08]',
        className
      )}
      title={`Locked at launch: holders get ${holders}% and the creator ${100 - holders}% of the ${pct(SPLIT.beneficiaryBps)} share of every trade.`}
    >
      Holders {holders}%
    </span>
  );
};
