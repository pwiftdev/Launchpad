import { useWatchlist } from '@/hooks/useWatchlist';
import { burstSparkles } from '@/lib/sparkles';
import { cn } from '@/lib/utils';

type StarButtonProps = {
  mint: string;
  /** On hover-capable screens, show only on row hover (or when starred) */
  revealOnHover?: boolean;
  className?: string;
};

/** Adds or removes a coin from the watchlist. Safe to place inside a link. */
export const StarButton = ({ mint, revealOnHover, className }: StarButtonProps) => {
  const { isWatched, toggle } = useWatchlist();
  const on = isWatched(mint);

  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? 'Unstar token' : 'Star token'}
      title={on ? 'Unstar token' : 'Star token'}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!on) burstSparkles(e.currentTarget, 8);
        toggle(mint);
      }}
      className={cn(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-all duration-200 ease-spring hover:scale-110 hover:bg-white/[0.08] active:scale-90',
        on
          ? 'text-amber drop-shadow-[0_0_8px_rgba(255,160,40,0.6)]'
          : 'text-neutral-500 hover:text-neutral-200',
        revealOnHover &&
          !on &&
          'has-hover:opacity-0 has-hover:focus-visible:opacity-100 has-hover:group-hover:opacity-100',
        className
      )}
    >
      <span className={cn('iconify h-4 w-4', on ? 'ph--star-fill' : 'ph--star')} />
    </button>
  );
};
