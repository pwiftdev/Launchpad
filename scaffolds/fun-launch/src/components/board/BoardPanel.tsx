import { cn } from '@/lib/utils';

type BoardPanelProps = React.PropsWithChildren<{
  id: string;
  title: string;
  /** Short flavour line under the title */
  subtitle?: string;
  icon: string;
  iconClassName?: string;
  count?: number;
  /** Cipher-style index shown before the title, e.g. 1 -> [01] */
  index?: number;
  /** Right side of the header, e.g. sort controls */
  controls?: React.ReactNode;
  className?: string;
}>;

/** A board column: titled header with optional controls, body scrolls on its own. */
export const BoardPanel = ({
  id,
  title,
  subtitle,
  icon,
  iconClassName,
  count,
  index,
  controls,
  className,
  children,
}: BoardPanelProps) => (
  <section
    aria-labelledby={`panel-${id}`}
    className={cn(
      'board-surface relative flex min-h-0 flex-col overflow-hidden border border-white/[0.09] bg-panel',
      className
    )}
  >
    {/* Light catching the top edge */}
    <span
      className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent"
      aria-hidden
    />
    <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-white/[0.06] pl-3 pr-2">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center bg-white/[0.04] ring-1 ring-inset ring-white/10">
        <span className={cn('iconify h-4 w-4', icon, iconClassName ?? 'text-neutral-400')} />
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <h2
            id={`panel-${id}`}
            className="truncate whitespace-nowrap font-display text-[13px] uppercase"
          >
            {index !== undefined && (
              <span className="mr-1.5 text-neutral-600">[{String(index).padStart(2, '0')}]</span>
            )}
            {title}
          </h2>
          {count !== undefined && (
            <span className="bg-white/[0.06] px-1.5 py-px font-pixel text-[10px] text-neutral-300">
              {count}
            </span>
          )}
        </div>
        {subtitle && <p className="truncate text-[10px] text-neutral-500">{subtitle}</p>}
      </div>
      <div className="ml-auto flex items-center">{controls}</div>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
  </section>
);

type SortOption<T extends string> = { id: T; label: string };

/** Compact segmented control used in panel headers. */
export function SortControl<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: SortOption<T>[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex gap-0.5 rounded-lg border border-neutral-800/60 bg-neutral-900/60 p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            'rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors',
            value === o.id
              ? 'bg-neutral-800 text-foreground shadow-sm'
              : 'text-neutral-500 hover:text-neutral-200'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
