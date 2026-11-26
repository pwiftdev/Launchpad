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

type Feature = {
  title: string;
  description: string;
  context?: string;
};

type Stage = {
  id: string;
  label: string;
  icon: string;
  color: string;
  features: Feature[];
};

const MASKED_SPLIT = feeMode(LAUNCH_FEE_MODE).split;

const ROADMAP: Stage[] = [
  {
    id: 'shipped',
    label: 'Shipped',
    icon: 'ph--check-bold',
    color: 'border-neutral-700 text-foreground',
    features: [
      {
        title: 'One launch type with a locked fee split',
        description: `Every new coin launches as Masked, paired with SOL. The creator splits ${pct(MASKED_SPLIT.beneficiaryBps)} of every trade with holders in 10% steps. The split is signed with the launch and can never change.`,
      },
      {
        title: 'Token creation and metadata',
        description: `Set a name, ticker, description, artwork up to ${LAUNCH_IMAGE_MAX_MB} MB and social links, and bundle an optional first buy of up to ${DEV_BUY_MAX_PERCENT_OF_SUPPLY}% of supply.`,
      },
      {
        title: 'One-slot fee guard and bonding',
        description: `Trades in the creation slot pay ${pct(SCHEDULE.startingFeeBps)}, with the creator’s bundled first buy paying ${pct(SCHEDULE.endingFeeBps)}. The fee is ${pct(SCHEDULE.endingFeeBps)} from the next slot. At ${MIGRATION_THRESHOLD_SOL} SOL in reserves, the pool can migrate to Meteora DAMM v2, where trades also pay ${pct(SCHEDULE.migrationFeeBps)}.`,
      },
      {
        title: 'Trading and transaction receipts',
        description:
          'Buy and sell on the bonding curve or the migrated pool. The transaction keeps the minimum output shown before signing. Saved receipts let you check pending launches, swaps and migrations after a refresh.',
      },
      {
        title: 'Wallet access and screen privacy',
        description:
          'Connect a Solana wallet and sign actions without creating an account. Screen privacy mode blurs wallet addresses in the interface.',
      },
      {
        title: 'Official MSKD mint',
        description:
          'The board pins the verified $MSKD mint, and launches cannot reuse the Masked or MSKD name.',
      },
    ],
  },
  {
    id: 'in-progress',
    label: 'In progress',
    icon: 'ph--git-commit-bold',
    color: 'border-primary/50 text-primary',
    features: [
      {
        title: 'Live market data',
        description:
          'Our own indexer streams every Masked trade into one database, so trades, charts and full holder lists update within seconds for every viewer.',
      },
    ],
  },
  {
    id: 'incoming',
    label: 'Incoming',
    icon: 'ph--circle-dashed-bold',
    color: 'border-neutral-800 text-neutral-400',
    features: [
      {
        title: 'Claim in native Monero or SOL',
        context: 'Planned',
        description:
          'One claim screen for creators and holders. Claim in native XMR, sent to the Monero address you enter, or in SOL. If native XMR payouts are down, claims are offered in wXMR instead.',
      },
      {
        title: 'Time-weighted holder rewards',
        context: 'Planned',
        description:
          'Holder shares follow how much you held across each hour, not one snapshot, so buying just before the hour earns nothing extra.',
      },
      {
        title: `$MSKD buyback and burn`,
        context: 'Planned',
        description: `${pct(MASKED_SPLIT.buybackBps)} of every Masked trade buys $MSKD on the market and burns it, with a public receipt for every burn.`,
      },
      {
        title: 'Proof of payouts',
        context: 'Planned',
        description:
          'A public page for every payout period: fees claimed, $MSKD burned, SOL and XMR paid out and how many people were paid, with a published Monero view key.',
      },
      {
        title: 'Independent audit',
        context: 'Planned',
        description:
          'A third-party review of fee collection, the reward ledger and the Monero treasury before the public relaunch.',
      },
    ],
  },
];

export default function Roadmap() {
  return (
    <Page containerClassName="max-w-4xl">
      <Head>
        <title>{`Roadmap | ${BRAND.name}`}</title>
        <meta
          name="description"
          content={`Shipped, in progress and incoming work at ${BRAND.name}.`}
        />
      </Head>

      <header className="pb-8 pt-4 md:pb-10 md:pt-8">
        <h1 className="font-display text-4xl uppercase leading-none md:text-6xl">Roadmap</h1>
        <p className="mt-4 text-sm text-neutral-400">
          Development began the week of <time dateTime="2026-11-16">16 November 2026</time>.
        </p>
        <nav aria-label="Roadmap sections" className="mt-5 flex flex-wrap gap-2">
          {ROADMAP.map(({ id, label, color }) => (
            <a
              key={id}
              href={`#${id}`}
              className={cn(
                'rounded-full border px-3 py-1.5 font-mono text-xs transition-colors hover:border-primary hover:text-primary',
                color
              )}
            >
              {label}
            </a>
          ))}
        </nav>
      </header>

      <div className="space-y-5">
        {ROADMAP.map((stage) => (
          <RoadmapStage key={stage.id} stage={stage} />
        ))}
      </div>
    </Page>
  );
}

function RoadmapStage({ stage }: { stage: Stage }) {
  const { id, label, icon, color, features } = stage;
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="surface scroll-mt-4 p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <span className={cn('grid h-8 w-8 place-items-center rounded-lg border', color)}>
          <span aria-hidden="true" className={cn('iconify h-4 w-4', icon)} />
        </span>
        <h2 id={`${id}-heading`} className="font-display text-sm uppercase tracking-wide">
          {label}
        </h2>
      </div>

      <ol className="ml-[15px] border-l border-neutral-800 pt-3">
        {features.map(({ title, context, description }) => (
          <li
            key={title}
            className="relative ml-5 border-b border-neutral-850 pb-4 pt-3 last:border-0 last:pb-0 sm:ml-7"
          >
            <span
              aria-hidden="true"
              className="absolute -left-5 top-[22px] w-3 border-t border-neutral-800 sm:-left-7 sm:w-5"
            />
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="text-sm font-semibold text-foreground sm:text-base">{title}</h3>
              {context && <span className="font-mono text-xs text-neutral-400">{context}</span>}
            </div>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-neutral-400">{description}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
