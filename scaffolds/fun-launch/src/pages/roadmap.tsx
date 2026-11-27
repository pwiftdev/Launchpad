import Head from 'next/head';
import Page from '@/components/ui/Page/Page';
import { BRAND } from '@/constants/brand';
import {
  DEV_BUY_MAX_PERCENT_OF_SUPPLY,
  LAUNCH_IMAGE_MAX_MB,
  MIGRATION_THRESHOLD_SOL,
} from '@/constants/launch';
import { LAUNCH_FEE_MODE, SCHEDULE, feeMode, pct } from '@/lib/feeModes';
import { cn } from '@/lib/utils';
export { requireAdminPage as getServerSideProps } from '@/server/adminPage';

type Status = 'shipped' | 'building' | 'next' | 'later';

type Feature = {
  title: string;
  description: string;
  status: Status;
};

type Phase = {
  id: string;
  number: number;
  title: string;
  summary: string;
  features: Feature[];
};

const MASKED_SPLIT = feeMode(LAUNCH_FEE_MODE).split;

/** The build plan, phase by phase, as it stands today. */
const PHASES: Phase[] = [
  {
    id: 'focus',
    number: 0,
    title: 'Focus',
    summary: 'One launch type, done well.',
    features: [
      {
        status: 'shipped',
        title: 'One launch type with a locked fee split',
        description: `Every new coin launches as Masked, paired with SOL. The creator splits ${pct(MASKED_SPLIT.beneficiaryBps)} of every trade with holders in 10% steps. The split is signed with the launch and can never change.`,
      },
      {
        status: 'shipped',
        title: 'Token creation and metadata',
        description: `Set a name, ticker, description, artwork up to ${LAUNCH_IMAGE_MAX_MB} MB and social links, and bundle an optional first buy of up to ${DEV_BUY_MAX_PERCENT_OF_SUPPLY}% of supply.`,
      },
      {
        status: 'shipped',
        title: 'One-slot fee guard and bonding',
        description: `Trades in the creation slot pay ${pct(SCHEDULE.startingFeeBps)}, with the creator’s bundled first buy paying ${pct(SCHEDULE.endingFeeBps)}. The fee is ${pct(SCHEDULE.endingFeeBps)} from the next slot. At ${MIGRATION_THRESHOLD_SOL} SOL in reserves, the pool can migrate to Meteora DAMM v2, where trades also pay ${pct(SCHEDULE.migrationFeeBps)}.`,
      },
      {
        status: 'shipped',
        title: 'Official MSKD mint',
        description:
          'The board pins the verified $MSKD mint, and launches cannot reuse the Masked or MSKD name.',
      },
    ],
  },
  {
    id: 'fast-data',
    number: 1,
    title: 'Fast data',
    summary: 'Every trade on screen within seconds.',
    features: [
      {
        status: 'shipped',
        title: 'Live market data',
        description:
          'One indexer streams every Masked trade into our own database, so trades, charts and full holder lists update within seconds for every viewer.',
      },
      {
        status: 'shipped',
        title: 'Trading and transaction receipts',
        description:
          'Buy and sell on the bonding curve or the migrated pool. The transaction keeps the minimum output shown before signing. Saved receipts let you check pending launches, swaps and migrations after a refresh.',
      },
      {
        status: 'shipped',
        title: 'Wallet access and screen privacy',
        description:
          'Connect a Solana wallet and sign actions without creating an account. Screen privacy mode blurs wallet addresses in the interface.',
      },
    ],
  },
  {
    id: 'payouts',
    number: 2,
    title: 'Earn and claim',
    summary: 'Fair rewards, claimed in one place.',
    features: [
      {
        status: 'shipped',
        title: 'Time-weighted holder rewards',
        description:
          'Holder shares follow how much you held across each hour, measured every five minutes, so buying just before the hour earns almost nothing extra.',
      },
      {
        status: 'shipped',
        title: 'Claim in wXMR or SOL',
        description:
          'One claim on My earnings for creator and holder rewards across Masked coins. Wrapped Monero (wXMR) and SOL pay to your connected Solana wallet.',
      },
      {
        status: 'building',
        title: 'Native Monero payouts',
        description:
          'Direct payouts to Monero wallets are in development. We are testing treasury settlement and payout recovery before opening claims.',
      },
    ],
  },
  {
    id: 'proof',
    number: 3,
    title: 'Proof and trust',
    summary: 'Check every number yourself.',
    features: [
      {
        status: 'shipped',
        title: 'Proof of payouts',
        description:
          'Daily totals for fees, wXMR and SOL payouts, and $MSKD bought and burned, with public burn receipts.',
      },
      {
        status: 'shipped',
        title: '$MSKD buyback and burn',
        description: `${pct(MASKED_SPLIT.buybackBps)} of every Masked trade funds buying $MSKD from its pool and burning it.`,
      },
      {
        status: 'next',
        title: 'Independent audit',
        description:
          'A third-party review of fee collection, the reward ledger and the Monero treasury before the public relaunch.',
      },
    ],
  },
  {
    id: 'relaunch',
    number: 4,
    title: 'Relaunch',
    summary: 'Open the doors, led by the proof page.',
    features: [
      {
        status: 'next',
        title: 'Public relaunch',
        description:
          'A relaunch that leads with the proof page, with the first launches seeded by creators who bring real volume.',
      },
    ],
  },
  {
    id: 'grow',
    number: 5,
    title: 'Grow',
    summary: 'After a clean month of payouts.',
    features: [
      {
        status: 'later',
        title: 'Referrals, alerts and creator vesting',
        description:
          'Rewards for bringing traders, alerts for the coins you hold, optional vesting for creators, and a mobile pass over every screen.',
      },
    ],
  },
];

const STATUS: Record<Status, { label: string; chip: string; icon: string }> = {
  shipped: {
    label: 'Shipped',
    chip: 'border-emerald/25 bg-emerald/10 text-emerald',
    icon: 'ph--check-bold text-emerald',
  },
  building: {
    label: 'Building',
    chip: 'border-primary/30 bg-primary/10 text-primary',
    icon: 'ph--circle-notch-bold animate-spin text-primary [animation-duration:2.4s]',
  },
  next: {
    label: 'Next',
    chip: 'border-white/15 bg-white/[0.06] text-neutral-200',
    icon: 'ph--arrow-right-bold text-neutral-300',
  },
  later: {
    label: 'Later',
    chip: 'border-white/10 bg-transparent text-neutral-400',
    icon: 'ph--circle-dashed-bold text-neutral-500',
  },
};

function phaseStatus(phase: Phase): Status {
  const statuses = phase.features.map((f) => f.status);
  if (statuses.every((s) => s === 'shipped')) return 'shipped';
  if (statuses.some((s) => s === 'shipped' || s === 'building')) return 'building';
  return statuses.includes('next') ? 'next' : 'later';
}

export default function Roadmap() {
  const shipped = PHASES.flatMap((p) => p.features).filter((f) => f.status === 'shipped').length;
  const total = PHASES.flatMap((p) => p.features).length;
  const done = PHASES.filter((p) => phaseStatus(p) === 'shipped').length;
  return (
    <Page containerClassName="max-w-4xl">
      <Head>
        <title>{`Roadmap | ${BRAND.name}`}</title>
        <meta
          name="description"
          content={`What ${BRAND.name} has shipped, what we are building and what comes next.`}
        />
      </Head>

      <header className="pb-8 pt-4 md:pb-10 md:pt-8">
        <p className="eyebrow">Roadmap</p>
        <h1 className="mt-4 text-[38px] font-semibold leading-[1.02] tracking-[-0.045em] md:text-[56px]">
          What we’re building.
          <br />
          <span className="text-holo">In the open.</span>
        </h1>
        <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-neutral-400">
          Six phases, each shipped only when the one before it holds up. Development began the week
          of <time dateTime="2026-11-16">16 November 2026</time>.
        </p>
        <div className="surface mt-6 rounded-3xl p-4 sm:p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-[13px] text-neutral-400">
              <span className="font-mono text-[22px] font-semibold tracking-tight text-foreground">
                {shipped}
              </span>{' '}
              of {total} milestones shipped
            </p>
            <p className="font-mono text-[12px] text-neutral-500">
              {done} of {PHASES.length} phases complete
            </p>
          </div>
          <div className="mt-3 flex gap-1.5" aria-hidden>
            {PHASES.map((phase) => {
              const status = phaseStatus(phase);
              return (
                <a
                  key={phase.id}
                  href={`#${phase.id}`}
                  className="group flex-1"
                  title={`Phase ${phase.number}: ${phase.title}`}
                >
                  <span
                    className={cn(
                      'block h-2 rounded-full transition-all duration-200 ease-out group-hover:scale-y-150',
                      status === 'shipped' && 'bond-fill',
                      status === 'building' &&
                        'bg-gradient-to-r from-primary/80 to-primary/20 shadow-[0_0_12px_rgba(255,102,0,0.35)]',
                      status === 'next' && 'bg-white/15',
                      status === 'later' && 'bg-white/[0.06]'
                    )}
                  />
                  <span className="mt-2 hidden truncate text-[11px] text-neutral-500 transition-colors group-hover:text-neutral-200 sm:block">
                    {phase.title}
                  </span>
                </a>
              );
            })}
          </div>
        </div>
      </header>

      <ol className="relative space-y-4">
        {/* The spine the phases hang from */}
        <span
          aria-hidden
          className="absolute bottom-6 left-[27px] top-6 w-px bg-gradient-to-b from-primary/60 via-white/10 to-transparent sm:left-[31px]"
        />
        {PHASES.map((phase, index) => (
          <PhaseCard key={phase.id} phase={phase} index={index} />
        ))}
      </ol>
    </Page>
  );
}

const STAGGER = ['enter-1', 'enter-2', 'enter-3', 'enter-4'];

function PhaseCard({ phase, index }: { phase: Phase; index: number }) {
  const status = phaseStatus(phase);
  return (
    <li
      id={phase.id}
      aria-labelledby={`${phase.id}-heading`}
      className={cn(
        'enter relative scroll-mt-6 pl-[64px] sm:pl-[76px]',
        STAGGER[Math.min(index, 3)]
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute left-0 top-4 grid h-14 w-14 place-items-center rounded-2xl font-mono text-[15px] font-semibold sm:h-16 sm:w-16 sm:text-[17px]',
          status === 'shipped' &&
            'bg-gradient-to-b from-[#ff8f45] to-[#f25a00] text-[#1a0900] shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_12px_28px_-10px_rgba(255,102,0,0.7)]',
          status === 'building' &&
            'bg-gradient-to-b from-white/[0.12] to-white/[0.03] text-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_0_0_1px_rgba(255,102,0,0.45),0_0_26px_-6px_rgba(255,102,0,0.6)]',
          (status === 'next' || status === 'later') &&
            'bg-gradient-to-b from-white/[0.08] to-white/[0.02] text-neutral-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] ring-1 ring-inset ring-white/10'
        )}
      >
        {String(phase.number).padStart(2, '0')}
        {status === 'building' && (
          <span className="absolute -right-1 -top-1 flex h-3 w-3">
            <span className="absolute inset-0 animate-ping rounded-full bg-primary/70" />
            <span className="relative h-3 w-3 rounded-full bg-primary ring-2 ring-background" />
          </span>
        )}
      </span>
      <section className="surface rounded-3xl p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 id={`${phase.id}-heading`} className="text-[19px] font-semibold tracking-tight">
            {phase.title}
          </h2>
          <span className={cn('chip', STATUS[status].chip)}>{STATUS[status].label}</span>
          <p className="w-full text-[13px] text-neutral-400 sm:ml-auto sm:w-auto">
            {phase.summary}
          </p>
        </div>
        <ul className="mt-3 space-y-1">
          {phase.features.map(({ title, description, status: featureStatus }) => (
            <li
              key={title}
              className="group -mx-2 flex gap-3 rounded-2xl px-2 py-2.5 transition-colors duration-200 hover:bg-white/[0.035]"
            >
              <span
                aria-hidden
                className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/[0.05] ring-1 ring-inset ring-white/[0.08]"
              >
                <span className={cn('iconify h-3.5 w-3.5', STATUS[featureStatus].icon)} />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-[14.5px] font-semibold text-foreground">{title}</h3>
                  {featureStatus !== 'shipped' && (
                    <span className={cn('chip py-0 text-[10px]', STATUS[featureStatus].chip)}>
                      {STATUS[featureStatus].label}
                    </span>
                  )}
                </div>
                <p className="mt-1 max-w-2xl text-[13.5px] leading-relaxed text-neutral-400">
                  {description}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </li>
  );
}
