import Image from 'next/image';
import heliusLogo from '@/assets/helius-horizontal.png';
import { Decrypt } from '@/components/brand/Decrypt';
import { cn } from '@/lib/utils';
import { OtcIcon, OtcPulse, OtcSectionLink } from './OtcLayout';

export type OtcSettlement = 'enabled' | 'recovery' | undefined;
export type OtcFlowStep = 'create' | 'share' | 'agree' | 'fund' | 'settle' | 'withdraw';

type Step = { id: OtcFlowStep; title: string; text: string; icon: `ph--${string}` };

const OFFER_STEPS: Step[] = [
  {
    id: 'create',
    title: 'Create',
    text: 'Set both amounts, an expiry and, if you like, the one wallet allowed to see it.',
    icon: 'ph--note-pencil',
  },
  {
    id: 'share',
    title: 'Share',
    text: 'Send the private link however you already talk to your counterparty.',
    icon: 'ph--link',
  },
  {
    id: 'agree',
    title: 'Agree',
    text: 'They sign the exact terms with their wallet. Off-chain. No funds move.',
    icon: 'ph--handshake',
  },
];

const SETTLEMENT_STEPS: Step[] = [
  {
    id: 'fund',
    title: 'Fund',
    text: 'Each side deposits its asset into its own deal wallet, plus a small SOL fee reserve.',
    icon: 'ph--wallet',
  },
  {
    id: 'settle',
    title: 'Settle',
    text: 'Both wallets verify and sign one transaction. Both sides swap together or not at all.',
    icon: 'ph--arrows-left-right',
  },
  {
    id: 'withdraw',
    title: 'Withdraw',
    text: 'Move what you received to your wallet. If the deadline passes first, recover your deposit.',
    icon: 'ph--arrow-line-down',
  },
];

export const otcFlowSteps = (settlement: OtcSettlement) =>
  settlement === 'enabled' ? [...OFFER_STEPS, ...SETTLEMENT_STEPS] : OFFER_STEPS;

export function OtcHero({
  mode,
  settlement,
}: {
  mode: 'mainnet' | 'test' | null;
  settlement: OtcSettlement;
}) {
  const live = settlement === 'enabled';
  const status = !mode
    ? { label: 'Unavailable', tone: 'text-neutral-400' }
    : live
      ? { label: 'Settlement live', tone: 'text-primary' }
      : settlement === 'recovery'
        ? { label: 'Recovery only', tone: 'text-amber' }
        : { label: 'Offers only', tone: 'text-neutral-200' };
  return (
    <header className="relative pb-8 pt-2 md:pb-10 md:pt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="eyebrow flex items-center gap-2">
          {mode && <OtcPulse />}
          Confidential OTC desk
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 sm:gap-x-6">
          <a
            href="https://www.helius.dev/privacy"
            target="_blank"
            rel="noreferrer"
            aria-label="Helius Privacy Rings (opens in a new tab)"
            className="inline-flex shrink-0 items-center rounded-sm py-1"
          >
            <Image src={heliusLogo} alt="Helius" className="h-auto w-20 sm:w-24" unoptimized />
          </a>
          {mode && (
            <dl className="flex items-stretch border border-neutral-800 font-term text-[10px] uppercase tracking-[0.12em]">
              <div className="flex items-center gap-1.5 px-2.5 py-1.5">
                <dt className="sr-only">Network</dt>
                <OtcIcon name="ph--globe-simple" className="h-3.5 w-3.5 text-neutral-500" />
                <dd className="text-neutral-300">
                  {mode === 'mainnet' ? 'Mainnet' : 'Test network'}
                </dd>
              </div>
              <div className="flex items-center gap-1.5 border-l border-neutral-800 px-2.5 py-1.5">
                <dt className="sr-only">Status</dt>
                <dd className={status.tone}>{status.label}</dd>
              </div>
            </dl>
          )}
        </div>
      </div>
      <h1
        aria-label="Your terms. Your counterparty."
        className="mt-5 font-display text-[24px] uppercase leading-[1.08] min-[420px]:text-[28px] sm:text-[40px] md:text-[54px]"
      >
        <Decrypt text="Your terms." />
        <br />
        <Decrypt text="Your counterparty." delay={180} className="text-holo" />
      </h1>
      <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-neutral-400">
        {live
          ? 'Trade size directly with one wallet at a price you both fixed in advance. No order book, no slippage, no price impact on the chart. Both sides settle in a single transaction.'
          : 'Agree on a fixed-price trade directly with one wallet, by private link. No order book, no slippage, and nothing posted publicly.'}
      </p>
      <p className="mt-5 font-term text-[10px] uppercase tracking-[0.14em] text-neutral-600">
        price <span className="text-neutral-400">fixed</span> · order book{' '}
        <span className="text-neutral-400">none</span> · terms{' '}
        <span className="whitespace-nowrap text-acid">off-chain</span>
        {live && (
          <>
            {' '}
            · settlement <span className="text-acid">encrypted</span>
          </>
        )}
      </p>
    </header>
  );
}

/** The whole trade at a glance, one hairline tile per step. */
export function OtcFlow({
  settlement,
  active,
  className,
}: {
  settlement: OtcSettlement;
  active?: OtcFlowStep;
  className?: string;
}) {
  const steps = otcFlowSteps(settlement);
  const activeIndex = steps.findIndex(({ id }) => id === active);
  return (
    <section aria-labelledby="otc-flow" className={cn('mb-6', className)}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id="otc-flow" className="eyebrow">
          How a trade moves
        </h2>
        <OtcSectionLink
          section="otc-explainer"
          className="font-term text-[10px] uppercase tracking-[0.12em] text-neutral-500 transition-colors hover:text-primary"
        >
          Full walkthrough ↓
        </OtcSectionLink>
      </div>
      <ol
        className={cn(
          'grid gap-px border border-white/[0.08] bg-white/[0.08]',
          steps.length > 3 ? 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-6' : 'sm:grid-cols-3'
        )}
      >
        {steps.map((step, index) => {
          const current = index === activeIndex;
          const done = activeIndex > index;
          return (
            <li
              key={step.id}
              aria-current={current ? 'step' : undefined}
              className={cn(
                'relative min-w-0 bg-panel px-4 pb-4 pt-3.5 transition-colors',
                current && 'bg-primary/[0.06]'
              )}
            >
              {current && (
                <span aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-primary" />
              )}
              <div className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    'font-pixel text-[22px] leading-none',
                    current ? 'text-primary' : done ? 'text-neutral-300' : 'text-neutral-600'
                  )}
                >
                  {String(index + 1).padStart(2, '0')}
                </span>
                <OtcIcon
                  name={done ? 'ph--check' : step.icon}
                  className={cn(
                    'h-4 w-4',
                    current ? 'text-primary' : done ? 'text-emerald' : 'text-neutral-500'
                  )}
                />
              </div>
              <h3 className="mt-3 font-display text-[13px] uppercase">
                {step.title}
                {current && <span className="sr-only"> (you are here)</span>}
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-neutral-400">{step.text}</p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
