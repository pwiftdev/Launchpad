import { cn } from '@/lib/utils';

/** Flat side-column section: a fixed-height title row, then content on the same 16px gutter. */
export const PanelSection = ({
  title,
  aside,
  label,
  className,
  children,
}: React.PropsWithChildren<{
  title: React.ReactNode;
  aside?: React.ReactNode;
  /** Accessible name when the title is not plain text */
  label?: string;
  className?: string;
}>) => (
  <section
    aria-label={label ?? (typeof title === 'string' ? title : undefined)}
    className={cn('px-4 pb-4', className)}
  >
    <div className="flex h-10 items-center justify-between gap-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
        {title}
      </h3>
      {aside}
    </div>
    {children}
  </section>
);
