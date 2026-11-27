import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export type SegmentOption<T extends string> = {
  id: T;
  label: React.ReactNode;
  /** Accessible name when the label is only an icon */
  ariaLabel?: string;
  icon?: string;
};

type Tone = 'neutral' | 'orange' | 'buy' | 'sell';

const THUMB: Record<Tone, string> = {
  neutral:
    'bg-gradient-to-b from-white/[0.16] to-white/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_6px_16px_-6px_rgba(0,0,0,0.9)]',
  orange:
    'bg-gradient-to-b from-[#ff8f45] to-[#f25a00] shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_8px_20px_-8px_rgba(255,102,0,0.8)]',
  buy: 'bg-gradient-to-b from-emerald/40 to-emerald/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_8px_22px_-8px_rgba(62,222,140,0.6)] ring-1 ring-emerald/40',
  sell: 'bg-gradient-to-b from-rose/40 to-rose/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_8px_22px_-8px_rgba(255,92,108,0.6)] ring-1 ring-rose/40',
};

/**
 * Segmented control with a glass thumb that glides to the selected option. Used for every
 * toggle on the site: sorting, density, buy and sell, chart ranges, claim currency.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  tone = 'neutral',
  toneFor,
  size = 'sm',
  stretch,
  disabled = false,
  className,
  role = 'radiogroup',
}: {
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  label: string;
  tone?: Tone;
  /** Tone per option, e.g. buy green and sell red */
  toneFor?: (id: T) => Tone;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  /** Options share the full width */
  stretch?: boolean;
  disabled?: boolean;
  className?: string;
  role?: 'radiogroup' | 'tablist';
}) {
  const host = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  const [ready, setReady] = useState(false);

  const measure = useCallback(() => {
    const el = host.current?.querySelector<HTMLElement>(`[data-segment="${value}"]`);
    if (el) setThumb({ left: el.offsetLeft, width: el.offsetWidth });
  }, [value]);

  useIsoLayoutEffect(() => {
    measure();
    // Animate only after the first placement, so the thumb never flies in on load
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, [measure, options.length]);

  useEffect(() => {
    const el = host.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  const activeTone = toneFor ? toneFor(value) : tone;
  const item = role === 'tablist' ? 'tab' : 'radio';

  return (
    <div
      ref={host}
      role={role}
      aria-label={label}
      className={cn(
        'well relative isolate flex gap-0.5 p-[3px]',
        size === 'lg' ? 'rounded-2xl p-1' : 'rounded-xl',
        stretch && 'w-full',
        className
      )}
    >
      {thumb && (
        <span
          aria-hidden
          className={cn(
            'absolute bottom-[3px] top-[3px] -z-10',
            size === 'lg' ? 'bottom-1 top-1 rounded-xl' : 'rounded-[9px]',
            THUMB[activeTone],
            ready &&
              'transition-[left,width,background-color,box-shadow] duration-300 ease-out motion-reduce:transition-none'
          )}
          style={{ left: thumb.left, width: thumb.width }}
        />
      )}
      {options.map((option, index) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role={item}
            data-segment={option.id}
            aria-checked={item === 'radio' ? selected : undefined}
            aria-selected={item === 'tab' ? selected : undefined}
            aria-label={option.ariaLabel}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.id)}
            onKeyDown={(event) => {
              const last = options.length - 1;
              let next: number;
              if (event.key === 'Home') next = 0;
              else if (event.key === 'End') next = last;
              else if (
                event.key === 'ArrowRight' ||
                (item === 'radio' && event.key === 'ArrowDown')
              )
                next = index === last ? 0 : index + 1;
              else if (event.key === 'ArrowLeft' || (item === 'radio' && event.key === 'ArrowUp'))
                next = index === 0 ? last : index - 1;
              else return;
              event.preventDefault();
              host.current
                ?.querySelectorAll<HTMLButtonElement>('button[data-segment]')
                [next]?.focus();
              onChange(options[next]!.id);
            }}
            className={cn(
              'relative flex items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors duration-200',
              size === 'xs' && 'h-6 rounded-[9px] px-2 text-[10.5px]',
              size === 'sm' && 'h-7 rounded-[9px] px-2.5 text-[11.5px]',
              size === 'md' && 'h-9 rounded-[10px] px-3.5 text-[13px]',
              size === 'lg' && 'h-11 rounded-xl px-4 text-[14px] font-semibold',
              stretch && 'flex-1',
              selected
                ? activeTone === 'orange'
                  ? 'text-[#1a0900]'
                  : activeTone === 'buy'
                    ? 'text-emerald-200'
                    : activeTone === 'sell'
                      ? 'text-rose-200'
                      : 'text-foreground'
                : 'text-neutral-400 hover:text-neutral-100'
            )}
          >
            {option.icon && <span aria-hidden className={cn('iconify h-3.5 w-3.5', option.icon)} />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
