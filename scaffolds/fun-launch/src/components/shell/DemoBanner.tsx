import { useDemoMode } from '@/hooks/useDemoMode';
import Link from 'next/link';

export function DemoBanner() {
  const { available, visible, setVisible } = useDemoMode();
  if (!available) return null;
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-primary/15 bg-primary/[0.045] px-4 py-2 text-[11px] md:px-5">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-neutral-400">
        <span className="inline-flex items-center gap-1.5 font-semibold text-primary">
          <span className="iconify h-3.5 w-3.5 ph--paint-brush-fill" /> Design preview
        </span>
        <span>
          {visible
            ? '25 sample launches. Artwork and activity are illustrative.'
            : 'Showing on-chain launches only.'}
        </span>
      </p>
      <div className="flex shrink-0 items-center gap-2">
        {process.env.NEXT_PUBLIC_WHITELIST_ENABLED === 'true' && (
          <Link
            href="/whitelist"
            className="rounded-md border border-primary/30 px-2.5 py-1 font-medium text-primary sm:hidden"
          >
            Whitelist ↗
          </Link>
        )}
        <button
          type="button"
          onClick={() => setVisible(!visible)}
          aria-pressed={visible}
          className="shrink-0 rounded-md border border-neutral-800 px-2.5 py-1 font-medium text-neutral-300 transition-colors hover:border-primary/40 hover:text-primary"
        >
          {visible ? 'Hide samples' : 'Show samples'}
        </button>
      </div>
    </div>
  );
}
