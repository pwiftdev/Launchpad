import { cn } from '@/lib/utils';
import { FEE_MODE_IDS, feeMode, pct, SPLIT, type FeeModeId } from '@/lib/feeModes';

const ICON: Record<FeeModeId, string> = {
  mskd: 'ph--detective-fill',
  dev: 'ph--user-circle-fill',
  cashback: 'ph--arrows-clockwise-bold',
};

/** Three launch modes as a radio group. Same 1.25% for all; only the 0.60% changes hands. */
export const ModePicker = ({
  value,
  onChange,
}: {
  value: FeeModeId;
  onChange: (id: FeeModeId) => void;
}) => (
  <div role="radiogroup" aria-label="Launch mode" className="grid gap-2 sm:grid-cols-3">
    {FEE_MODE_IDS.map((id) => {
      const mode = feeMode(id);
      const selected = value === id;
      return (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={selected}
          onClick={() => onChange(id)}
          className={cn(
            'group relative flex flex-col items-start rounded-xl border p-3.5 text-left transition-[border-color,background-color] duration-150',
            selected
              ? 'border-foreground bg-neutral-900'
              : 'border-neutral-800 bg-neutral-950 hover:border-neutral-600'
          )}
        >
          <span className="flex w-full items-center gap-2">
            <span
              className={cn(
                'iconify h-4 w-4',
                ICON[id],
                selected ? 'text-acid' : 'text-neutral-500 group-hover:text-neutral-300'
              )}
            />
            <span className="text-[13px] font-semibold tracking-tight">
              {mode.label}
            </span>
            <span
              aria-hidden
              className={cn(
                'ml-auto flex h-3.5 w-3.5 items-center justify-center rounded-full border',
                selected ? 'border-foreground' : 'border-neutral-700'
              )}
            >
              {selected && <span className="h-1.5 w-1.5 rounded-full bg-signal" />}
            </span>
          </span>
          <span className="mt-2 text-[12px] leading-snug text-neutral-400">{mode.tagline}</span>
          <span className="mt-3 flex w-full items-baseline justify-between border-t border-neutral-850 pt-2.5">
            <span className="font-term text-[10px] uppercase tracking-wider text-neutral-500">
              {mode.beneficiaryLabel} {mode.beneficiary === 'creator' ? 'earns' : 'earn'}
            </span>
            <span className="font-mono text-sm font-semibold tabular text-foreground">
              {pct(SPLIT.beneficiaryBps)}
            </span>
          </span>
          <span className="mt-1 flex w-full items-baseline justify-between">
            <span className="font-term text-[10px] uppercase tracking-wider text-neutral-500">
              Paired to
            </span>
            <span className="font-mono text-[12px] text-neutral-300">{mode.quoteSymbol}</span>
          </span>
        </button>
      );
    })}
  </div>
);
