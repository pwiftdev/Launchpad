import type { ReactElement } from 'react';
import Link from 'next/link';
import { Dialog } from 'radix-ui';
import { BRAND } from '@/constants/brand';
import { cn } from '@/lib/utils';
import { LogoMark } from './Logo';
import { LAUNCH_FEE_MODE, SCHEDULE, feeMode, pct } from '@/lib/feeModes';

const { split } = feeMode(LAUNCH_FEE_MODE);

/** Staggered entrance for each block of the card: `className={cn(RISE, …)} style={delay(n)}`. */
const RISE = 'animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500';
const delay = (step: number) => ({ animationDelay: `${120 + step * 90}ms` });

export const ThesisModal = ({ children }: { children: ReactElement }) => {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>{children}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-[rgb(10_8_7/0.66)] backdrop-blur-[6px] data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:duration-200 data-[state=open]:duration-300" />
        <div className="pointer-events-none fixed inset-0 z-[91] flex items-end justify-center p-3 sm:items-center sm:p-6">
          <Dialog.Content
            aria-describedby="thesis-copy"
            className="holo-border pointer-events-auto relative flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[520px] flex-col overflow-hidden rounded-[30px] bg-[rgb(24_20_18/0.9)] shadow-[0_40px_120px_-20px_rgba(0,0,0,0.85)] outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-[0.98] data-[state=open]:slide-in-from-bottom-4 data-[state=closed]:duration-200 data-[state=open]:duration-300 sm:max-h-[calc(100dvh-3rem)]"
          >
            <div className="bg-halo pointer-events-none absolute inset-0" aria-hidden />
            <Dialog.Close
              className="absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-full text-neutral-400 ring-1 ring-inset ring-white/10 transition-all duration-200 ease-out hover:rotate-90 hover:bg-white/10 hover:text-foreground"
              aria-label="Close"
            >
              <span className="iconify h-4 w-4 ph--x" />
            </Dialog.Close>

            <div className="no-scrollbar relative overflow-y-auto overscroll-contain px-6 pb-6 pt-8 sm:px-9 sm:pb-8 sm:pt-10">
              <div className={RISE} style={delay(0)}>
                <LogoMark className="h-14 w-10 drop-shadow-[0_10px_24px_rgba(255,102,0,0.45)]" />
              </div>
              <p style={delay(1)} className={cn(RISE, 'eyebrow mt-6')}>
                The {BRAND.longName} manifesto
              </p>
              <Dialog.Title
                style={delay(1)}
                className={cn(
                  RISE,
                  'mt-3 text-[28px] font-semibold leading-[1.02] tracking-[-0.045em] sm:text-[34px]'
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

              {/* One fee, one split */}
              <div style={delay(3)} className={cn(RISE, 'mt-7 border-t border-white/[0.06] pt-6')}>
                <div className="flex items-baseline justify-between">
                  <p className="font-mono text-[40px] font-semibold leading-none tracking-tight">
                    {pct(SCHEDULE.endingFeeBps)}
                  </p>
                  <p className="text-right text-[12px] leading-snug text-neutral-500">
                    flat, before
                    <br />
                    and after bonding
                  </p>
                </div>
                <ul className="mt-5 divide-y divide-white/[0.05] border-y border-white/[0.06]">
                  {[
                    ['Creator and holders', split.beneficiaryBps, 'split by the creator, locked'],
                    ['Masked', split.houseBps, 'treasury'],
                    ['$MSKD', split.buybackBps, 'bought back and burned'],
                    ['Meteora', split.meteoraBps, 'protocol'],
                  ].map(([label, bps, note]) => (
                    <li key={label} className="flex items-center gap-3 py-3">
                      <span className="w-[8.5rem] shrink-0 text-[13px] font-medium">{label}</span>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-500">
                        {note}
                      </span>
                      <span className="font-mono text-[11px] text-neutral-500">
                        {pct(Number(bps))}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-[12px] text-neutral-500">
                  Claim earnings in wXMR or SOL. The launch slot alone charges{' '}
                  {pct(SCHEDULE.startingFeeBps)} to stop snipers.
                </p>
              </div>

              <div className={RISE} style={delay(4)}>
                <Dialog.Close className="btn-holo mt-7 flex h-12 w-full items-center justify-center gap-2 rounded-2xl text-[15px]">
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
