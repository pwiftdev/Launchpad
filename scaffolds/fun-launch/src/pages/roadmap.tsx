import Head from 'next/head';
import Page from '@/components/ui/Page/Page';
import { BRAND } from '@/constants/brand';
import {
  DEV_BUY_MAX_PERCENT_OF_SUPPLY,
  LAUNCH_IMAGE_MAX_MB,
  MIGRATION_THRESHOLD_SOL,
} from '@/constants/launch';
import { SCHEDULE, SPLIT, pct } from '@/lib/feeModes';
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

const ROADMAP: Stage[] = [
  {
    id: 'shipped',
    label: 'Shipped',
    icon: 'ph--check-bold',
    color: 'border-neutral-700 text-foreground',
    features: [
      {
        title: 'Confidential OTC',
        description:
          'Trade SOL against USDC, or pair MSKD or another eligible launchpad token with SOL or USDC. Share a fixed-price offer through an expiring link, then follow funding, settlement with Helius Privacy Rings, and withdrawal.',
      },
      {
        title: 'Wallet access and screen privacy',
        description:
          'Connect a Solana wallet and sign actions without creating an account. Screen privacy mode blurs wallet addresses and profiles in the interface.',
      },
      {
        title: 'Token creation and metadata',
        description: `Set a name, ticker, description, artwork up to ${LAUNCH_IMAGE_MAX_MB} MB and social links. Preview the token and bundle an optional first buy of up to ${DEV_BUY_MAX_PERCENT_OF_SUPPLY}% of supply.`,
      },
      {
        title: 'Private launch previews',
        description:
          'Save a draft and share it before launch with an expiring invite. You can restrict an invite to one wallet or revoke it early.',
      },
      {
        title: 'Regular Dev rewards',
        description: `Regular Dev pairs with SOL and routes ${pct(SPLIT.beneficiaryBps)} of the trade to the creator under the standard fee schedule. Creators can request their full available balance and track reserved and paid rewards separately.`,
      },
      {
        title: 'Cashback and wXMR holder rewards',
        description:
          'Regular Cashback pays eligible holders in SOL. MSKD mode converts the holder share to wXMR on Solana. Both modes use finalized hourly balance snapshots to determine rewards.',
      },
      {
        title: 'One-slot fee guard and bonding',
        description: `Trades in the creation slot pay ${pct(SCHEDULE.startingFeeBps)}, with the creator’s bundled first buy paying ${pct(SCHEDULE.endingFeeBps)}. The fee is ${pct(SCHEDULE.endingFeeBps)} from the next slot. At ${MIGRATION_THRESHOLD_SOL} SOL in reserves, the pool is eligible to migrate to Meteora DAMM v2, where trades pay ${pct(SCHEDULE.migrationFeeBps)}.`,
      },
      {
        title: 'Trading and transaction receipts',
        description:
          'Buy and sell on the bonding curve or the migrated pool. The transaction keeps the minimum output shown before signing. Saved receipts let you check pending token creation, swaps and migrations after a refresh.',
      },
      {
        title: 'Token discovery and market data',
        description:
          'Browse new, bonding and bonded tokens. Search by name, ticker or mint from the mobile bottom bar, and star tokens for your watchlist. Token pages show price charts, recent trades, holder balances and ownership concentration.',
      },
      {
        title: 'Official MSKD mint',
        description:
          'The board pins the verified Masked mint so you can find the official token by its address.',
      },
      {
        title: 'Profiles, token chat and sharing',
        description:
          'Set a wallet-linked profile, post signed callouts and join wallet-gated token chat with encrypted message storage. Share token links with preview cards.',
      },
      {
        title: 'Buyback and burn records',
        description:
          'Browse finalized buybacks for tokens with burn-enabled fee policies, including the SOL spent, tokens burned and on-chain receipt.',
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
        title: 'Health monitoring and recovery',
        description:
          'The payout worker gives user claims priority ahead of routine treasury transfers and logs alerts for delayed claims, signer errors and low SOL reserves. Service alert delivery and backup recovery are in progress.',
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
        title: 'Customizable launch settings',
        context: 'Idea',
        description:
          'Offer presets and settings for token supply, curve shape, bonding target and fee split within supported ranges. Show how the choices change pricing and liquidity before signing.',
      },
      {
        title: 'More launch pool pairing options',
        context: 'Idea',
        description:
          'Add USDC and other liquid quote assets alongside SOL, with bonding targets and trading quotes shown in the selected asset.',
      },
      {
        title: 'Native Monero cash-out',
        context: 'Planned',
        description:
          'Redeem wXMR rewards for native XMR through the bridge, with redemption fees and minimums shown before confirming.',
      },
      {
        title: 'Creator and holder dashboards',
        context: 'Idea',
        description:
          'See token performance and reward balances across multiple tokens, with claim history and exportable receipts.',
      },
      {
        title: 'Transparent token vesting',
        context: 'Idea',
        description:
          'Support on-chain vesting for creator and team allocations. Show locked balances and unlock dates on the token page.',
      },
      {
        title: 'Watchlist alerts',
        context: 'Idea',
        description: 'Let users opt in to price, bonding and reward alerts for tokens they follow.',
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
