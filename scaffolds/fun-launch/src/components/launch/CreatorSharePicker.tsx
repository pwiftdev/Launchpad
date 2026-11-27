import { cn } from '@/lib/utils';
import { CREATOR_SHARE_OPTIONS, CREATOR_SHARE_STEP_BPS, SPLIT, pct } from '@/lib/feeModes';

/**
 * The one launch choice: how the creator splits 0.60% of every trade with holders.
 * 10% steps, locked forever once the coin launches.
 */
export const CreatorSharePicker = ({
  value,
  onChange,
}: {
  value: number;
  onChange: (bps: number) => void;
}) => {
  const creator = value / 100;
  const creatorBps = (SPLIT.beneficiaryBps * value) / 10_000;
  const holdersBps = SPLIT.beneficiaryBps - creatorBps;
  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        <Share label="You, the creator" percent={creator} bps={creatorBps} />
        <Share label="Holders" percent={100 - creator} bps={holdersBps} align="right" />
      </div>
      <input
        type="range"
        min={0}
        max={10_000}
        step={CREATOR_SHARE_STEP_BPS}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Creator share of the fee"
        aria-valuetext={`Creator ${creator}%, holders ${100 - creator}%`}
        className="range-glass mt-5 w-full"
        style={{ '--fill': `${value / 100}%` } as React.CSSProperties}
      />
      <div className="mt-2 flex justify-between font-mono text-[10px] text-neutral-600" aria-hidden>
        {CREATOR_SHARE_OPTIONS.map((bps) => (
          <button
            key={bps}
            type="button"
            tabIndex={-1}
            onClick={() => onChange(bps)}
            className={cn(
              'w-7 rounded-md py-0.5 text-center transition-all duration-200 ease-out hover:text-neutral-200',
              bps === value && 'scale-110 font-semibold text-primary'
            )}
          >
            {bps / 100}
          </button>
        ))}
      </div>
      <p className="mt-4 flex gap-2.5 rounded-2xl border border-amber/20 bg-amber/[0.06] p-3.5 text-xs leading-relaxed text-neutral-300">
        <span aria-hidden className="iconify mt-px h-4 w-4 shrink-0 text-amber ph--lock-key-fill" />
        <span>
          <span className="font-semibold text-foreground">Locked forever.</span> The split is signed
          with your launch and written into the coin&rsquo;s metadata. Nobody can change it after
          launch, not you and not Masked.
        </span>
      </p>
    </div>
  );
};

const Share = ({
  label,
  percent,
  bps,
  align = 'left',
}: {
  label: string;
  percent: number;
  bps: number;
  align?: 'left' | 'right';
}) => (
  <div className={cn('tile p-4', align === 'right' && 'text-right')}>
    <p className="text-[12px] text-neutral-400">{label}</p>
    <p className="mt-1.5 font-mono text-[34px] font-semibold leading-none tracking-[-0.04em] transition-all duration-200">
      {percent}%
    </p>
    <p className="mt-1 font-mono text-[11px] text-neutral-500">{pct(bps)} of every trade</p>
  </div>
);
