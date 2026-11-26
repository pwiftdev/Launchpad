import { cn } from '@/lib/utils';
import {
  feeMode,
  pairingMode,
  pct,
  REWARD_MODES,
  rewardMode,
  SPLIT,
  type FeeModeId,
  type RewardMode,
} from '@/lib/feeModes';

const ICON: Record<RewardMode, string> = {
  mskd: 'ph--detective-fill',
  dev: 'ph--user-circle-fill',
  cashback: 'ph--arrows-clockwise-bold',
};

export const ModePicker = ({
  value,
  onChange,
  hsolModes,
}: {
  value: FeeModeId;
  onChange: (id: FeeModeId) => void;
  hsolModes: FeeModeId[];
}) => {
  const selectedReward = rewardMode(value);
  const selectedQuote = feeMode(value).quote;
  const hsol = pairingMode(selectedReward, 'hsol');
  const hsolAvailable = hsolModes.includes(hsol);
  const pairedMode = (id: RewardMode) => {
    const paired = pairingMode(id, selectedQuote);
    return hsolModes.includes(paired) ? paired : id;
  };
  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="Reward mode" className="grid gap-2 sm:grid-cols-3">
        {REWARD_MODES.map((id) => {
          const mode = feeMode(pairedMode(id));
          const selected = selectedReward === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(pairedMode(id))}
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
                  {feeMode(id).label}
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
                  Paid in
                </span>
                <span className="font-mono text-[12px] text-neutral-300">{mode.payoutSymbol}</span>
              </span>
            </button>
          );
        })}
      </div>
      <fieldset>
        <legend className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-400">
          Pair with
        </legend>
        <div className="grid grid-cols-2 gap-2 sm:max-w-sm">
          {(['sol', 'hsol'] as const).map((quote) => (
            <label
              key={quote}
              className={cn(
                'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
                selectedQuote === quote ? 'border-foreground bg-neutral-900' : 'border-neutral-800',
                quote === 'hsol' && !hsolAvailable ? 'opacity-50' : 'cursor-pointer'
              )}
            >
              <input
                type="radio"
                name="quote-asset"
                value={quote}
                className="accent-primary"
                checked={selectedQuote === quote}
                disabled={quote === 'hsol' && !hsolAvailable}
                onChange={() => onChange(pairingMode(selectedReward, quote))}
              />
              {quote === 'sol' ? 'SOL' : 'hSOL'}
            </label>
          ))}
        </div>
        {!hsolAvailable && (
          <p className="mt-2 text-xs text-neutral-500">
            hSOL pairing is unavailable for this mode.
          </p>
        )}
      </fieldset>
    </div>
  );
};
