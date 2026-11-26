import { otcAssetLabel, type OtcLeg, type OtcTerms } from '@/lib/otc';
import { cn } from '@/lib/utils';
import { OtcIcon } from './OtcLayout';

export function OtcAssetMark({ asset, className }: { asset: OtcLeg['asset']; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border',
        asset === 'SOL'
          ? 'border-primary/25 bg-primary/10 text-primary-200'
          : 'border-neutral-700 bg-neutral-850 text-neutral-100',
        className
      )}
    >
      <OtcIcon
        name={
          asset === 'SOL'
            ? 'ph--stack-simple'
            : asset === 'USDC'
              ? 'ph--currency-dollar'
              : 'ph--coins'
        }
        className="h-[1em] w-[1em]"
      />
    </span>
  );
}

export function OtcTermsCard({ terms, guest = false }: { terms: OtcTerms; guest?: boolean }) {
  return (
    <div className="relative grid grid-cols-2 border border-neutral-800 bg-neutral-950">
      <div className="min-w-0 p-3 pr-6 sm:p-4 sm:pr-8">
        <Leg label="You send" leg={guest ? terms.buy : terms.sell} />
      </div>
      <div className="min-w-0 border-l border-neutral-800 p-3 pl-6 sm:p-4 sm:pl-8">
        <Leg label="You receive" leg={guest ? terms.sell : terms.buy} />
      </div>
      <span className="absolute left-1/2 top-1/2 inline-flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center border border-neutral-700 bg-panel text-primary sm:h-8 sm:w-8">
        <OtcIcon name="ph--arrow-right" className="h-3.5 w-3.5" />
      </span>
    </div>
  );
}

function Leg({ label, leg }: { label: string; leg: OtcTerms['sell'] }) {
  return (
    <div className="min-w-0">
      <p className="font-term text-[10px] uppercase tracking-[0.12em] text-neutral-500">{label}</p>
      <p className="mt-1.5 break-all font-mono text-lg font-semibold tracking-tight sm:text-2xl">
        {leg.amount}
      </p>
      <p className="mt-1 flex items-center gap-1.5 text-xs font-medium text-neutral-200">
        <OtcAssetMark asset={leg.asset} className="h-5 w-5 text-[11px]" />
        {otcAssetLabel(leg)}
      </p>
      {leg.asset === 'TOKEN' && (
        <p
          className="mt-1 break-all font-mono text-[10px] text-neutral-400"
          title="Token mint address"
        >
          {leg.token.mint}
        </p>
      )}
    </div>
  );
}
