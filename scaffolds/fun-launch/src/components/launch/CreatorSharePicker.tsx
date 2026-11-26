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
        className="mt-4 h-2 w-full cursor-pointer appearance-none rounded-full bg-neutral-850 accent-primary"
      />
      <div className="mt-2 flex justify-between font-mono text-[10px] text-neutral-600" aria-hidden>
        {CREATOR_SHARE_OPTIONS.map((bps) => (
          <span key={bps} className={cn('w-6 text-center', bps === value && 'text-foreground')}>
            {bps / 100}
          </span>
        ))}
      </div>
      <p className="mt-3 rounded-xl border border-amber/20 bg-amber/5 p-3 text-xs leading-relaxed text-neutral-400">
        <span className="font-semibold text-foreground">Locked forever.</span> The split is signed
        with your launch and written into the coin&rsquo;s metadata. Nobody can change it after
        launch, not you and not Masked.
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
  <div className={cn('rounded-xl bg-neutral-950 p-3', align === 'right' && 'text-right')}>
    <p className="text-2xs uppercase tracking-wider text-neutral-500">{label}</p>
    <p className="mt-1 font-pixel text-[28px] leading-none">{percent}%</p>
    <p className="mt-1 font-mono text-[11px] text-neutral-500">{pct(bps)} of every trade</p>
  </div>
);
