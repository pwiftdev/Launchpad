import { cn } from '@/lib/utils';

/** Coins at or above this progress glow: they are close enough to beg for it. */
export const HOT_BOND_PROGRESS = 0.8;

/**
 * The fill of a bonding bar. The gradient is sized to the whole track, so a coin at 20%
 * shows only cobalt and one about to bond reaches the lime end.
 */
export const BondFill = ({
  progress,
  isMigrated,
  className,
}: {
  progress: number;
  isMigrated?: boolean;
  className?: string;
}) => {
  const pct = isMigrated ? 100 : Math.min(Math.max(progress * 100, 0), 100);
  const shown = Math.max(pct, pct > 0 ? 3 : 0);
  return (
    <div
      className={cn(
        'bond-fill h-full transition-[width] duration-700',
        !isMigrated && progress >= HOT_BOND_PROGRESS && 'bond-hot',
        className
      )}
      style={
        {
          width: `${shown}%`,
          '--bond-size': shown > 0 ? `${(100 / shown) * 100}%` : '100%',
        } as React.CSSProperties
      }
    />
  );
};

type BondingBarProps = {
  progress: number;
  isMigrated?: boolean;
  className?: string;
};

export const BondingBar = ({ progress, isMigrated, className }: BondingBarProps) => {
  const pct = isMigrated ? 100 : Math.min(Math.max(progress * 100, 0), 100);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-label="Bonding progress"
      className={cn('h-2 w-full overflow-hidden bg-white/[0.06]', className)}
    >
      <BondFill progress={progress} isMigrated={isMigrated} />
    </div>
  );
};
