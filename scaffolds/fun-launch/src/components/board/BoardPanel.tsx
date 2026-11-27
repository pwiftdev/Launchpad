import { cn } from '@/lib/utils';
import { Segmented } from '../ui/Segmented';

type BoardPanelProps = React.PropsWithChildren<{
  id: string;
  title: string;
  /** Short flavour line under the title */
  subtitle?: string;
  icon: string;
  iconClassName?: string;
  count?: number;
  /** Column number, shown as a quiet index before the title */
  index?: number;
  /** Right side of the header, e.g. sort controls */
  controls?: React.ReactNode;
  className?: string;
}>;

const STAGGER = ['enter-1', 'enter-2', 'enter-3', 'enter-4'];

/** A board column: a glass panel with a titled header; its list scrolls on its own. */
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
      'board-surface enter flex min-h-0 flex-col overflow-hidden rounded-3xl',
      index ? STAGGER[Math.min(index, STAGGER.length) - 1] : undefined,
      className
    )}
  >
    <header className="flex h-[60px] shrink-0 items-center gap-3 pl-4 pr-3">
      <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-b from-white/[0.12] to-white/[0.03] shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_6px_14px_-6px_rgba(0,0,0,0.9)] ring-1 ring-white/10">
        <span
          className={cn('iconify h-[18px] w-[18px]', icon, iconClassName ?? 'text-neutral-300')}
        />
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2
            id={`panel-${id}`}
            className="truncate whitespace-nowrap text-[15px] font-semibold tracking-tight"
          >
            {title}
          </h2>
          {count !== undefined && (
            <span className="rounded-full bg-white/[0.07] px-2 py-px font-mono text-[10.5px] font-medium tabular text-neutral-300 ring-1 ring-inset ring-white/[0.08]">
              {count}
            </span>
          )}
        </div>
        {subtitle && <p className="truncate text-[11px] text-neutral-500">{subtitle}</p>}
      </div>
      <div className="ml-auto flex items-center">{controls}</div>
    </header>
    <div className="mx-3 h-px shrink-0 bg-gradient-to-r from-transparent via-white/10 to-transparent" />
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2 pt-2">
      {children}
    </div>
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
  return <Segmented value={value} options={options} onChange={onChange} label={label} size="xs" />;
}
