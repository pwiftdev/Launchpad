import type { ReactElement } from 'react';
import Link from 'next/link';
import { Dialog } from 'radix-ui';
import { BRAND } from '@/constants/brand';
import { cn } from '@/lib/utils';
import { LogoMark } from './Logo';
import { REWARD_MODES, SCHEDULE, SPLIT, feeMode, pct } from '@/lib/feeModes';

/** Staggered entrance for each block of the card: `className={cn(RISE, …)} style={delay(n)}`. */
const RISE = 'animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-700';
const delay = (step: number) => ({ animationDelay: `${120 + step * 90}ms` });

export const ThesisModal = ({ children }: { children: ReactElement }) => {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>{children}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-black/80 backdrop-blur-sm data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:duration-200 data-[state=open]:duration-500" />
        <div className="pointer-events-none fixed inset-0 z-[91] flex items-end justify-center p-3 sm:items-center sm:p-6">
          <Dialog.Content
            aria-describedby="thesis-copy"
            className="holo-border pointer-events-auto relative flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[520px] flex-col overflow-hidden rounded-3xl bg-neutral-950 shadow-[0_40px_120px_-20px_rgba(0,0,0,0.8)] outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-[0.98] data-[state=open]:slide-in-from-bottom-4 data-[state=closed]:duration-200 data-[state=open]:duration-500 sm:max-h-[calc(100dvh-3rem)]"
          >
            <div className="bg-halo pointer-events-none absolute inset-0" aria-hidden />
            <Dialog.Close
              className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-900 hover:text-foreground"
              aria-label="Close"
            >
              <span className="iconify h-4 w-4 ph--x" />
            </Dialog.Close>

            <div className="no-scrollbar relative overflow-y-auto overscroll-contain px-6 pb-6 pt-8 sm:px-9 sm:pb-8 sm:pt-10">
              <div className={RISE} style={delay(0)}>
                <LogoMark className="h-14 w-10" />
              </div>
              <p style={delay(1)} className={cn(RISE, 'eyebrow mt-6')}>
                The {BRAND.longName} manifesto
              </p>
              <Dialog.Title
                style={delay(1)}
                className={cn(
                  RISE,
                  'mt-3 font-display text-[28px] uppercase leading-[1.05] sm:text-[34px]'
                )}
              >
                {BRAND.headline.top}
                <br />
                <span className="text-holo">{BRAND.headline.bottom}</span>
              </Dialog.Title>
              <p
                id="thesis-copy"
                style={delay(2)}
                className={cn(RISE, 'mt-4 max-w-sm text-[15px] leading-relaxed text-neutral-400')}
              >
                No KYC. No accounts. No email. Your wallet is your only login, and the coin you
                launch is yours.
              </p>

              {/* One fee, three modes */}
              <div style={delay(3)} className={cn(RISE, 'mt-7 border-t border-neutral-850 pt-6')}>
                <div className="flex items-baseline justify-between">
                  <p className="font-pixel text-[40px] leading-none">
                    {pct(SCHEDULE.endingFeeBps)}
                  </p>
                  <p className="text-right text-[12px] leading-snug text-neutral-500">
                    flat, before
                    <br />
                    and after bonding
                  </p>
                </div>
                <ul className="mt-5 divide-y divide-neutral-850 border-y border-neutral-850">
                  {REWARD_MODES.map((id) => {
                    const mode = feeMode(id);
                    return (
                      <li key={id} className="flex items-center gap-3 py-3">
                        <span className="w-[8.5rem] shrink-0 text-[13px] font-medium">
                          {mode.label}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-500">
                          {pct(SPLIT.beneficiaryBps)} to {mode.beneficiaryLabel.toLowerCase()}
                          {mode.quote !== 'sol' && `, in ${mode.payoutSymbol}`}
                        </span>
                        <span className="font-mono text-[11px] text-neutral-500">
                          {mode.quoteSymbol}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-3 text-[12px] text-neutral-500">
                  Every mode: house {pct(SPLIT.houseBps)}, Meteora {pct(SPLIT.meteoraBps)}. The
                  launch slot alone charges {pct(SCHEDULE.startingFeeBps)} to stop snipers.
                </p>
              </div>

              <div className={RISE} style={delay(4)}>
                <Dialog.Close className="btn-holo mt-7 flex h-12 w-full items-center justify-center gap-2 rounded-xl text-[15px]">
                  Enter {BRAND.name}
                </Dialog.Close>
                <p className="mt-3 text-center text-[12px] text-neutral-500">
                  <Dialog.Close asChild>
                    <Link
                      href="/rules"
                      className="underline-offset-4 hover:text-foreground hover:underline"
                    >
                      How fees work
                    </Link>
                  </Dialog.Close>
                  <span className="mx-2 text-neutral-700">·</span>
                  Check the live quote before you sign.
                </p>
              </div>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
