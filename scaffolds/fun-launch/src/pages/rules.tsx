import Head from 'next/head';
import Link from 'next/link';
import Page from '@/components/ui/Page/Page';
import { Decrypt } from '@/components/brand/Decrypt';
import { FeeSplit } from '@/components/fees/FeeSplit';
import { BRAND } from '@/constants/brand';
import { CREATOR_SHARE_STEP_BPS, LAUNCH_FEE_MODE, SCHEDULE, feeMode, pct } from '@/lib/feeModes';
import { adminPageRedirect } from '@/server/adminPage';
import type { GetServerSideProps } from 'next';

export const getServerSideProps: GetServerSideProps = async (context) =>
  adminPageRedirect(context) ?? { props: {} };

const MASKED = feeMode(LAUNCH_FEE_MODE);
const { split } = MASKED;
const EXAMPLES = [0, 5000, 10_000];

const RULES: [string, string][] = [
  [
    'One-slot launch guard',
    `The slot a coin is created in charges ${pct(SCHEDULE.startingFeeBps)} on buys and sells to discourage sniping. From the next slot the fee is ${pct(SCHEDULE.endingFeeBps)}. The creator's first buy, bundled with creation, pays ${pct(SCHEDULE.endingFeeBps)}. Dynamic fees are off.`,
  ],
  [
    `${pct(SCHEDULE.endingFeeBps)} flat`,
    `The trading fee is ${pct(SCHEDULE.endingFeeBps)} on the bonding curve and stays ${pct(SCHEDULE.migrationFeeBps)} on the Meteora DAMM v2 pool after bonding. It never steps down and never steps up.`,
  ],
  [
    'Bonding',
    'At the configured reserve target the curve migrates to Meteora DAMM v2. Migration needs confirmed on-chain transactions; reaching the target alone does not complete it. Launch liquidity stays permanently locked.',
  ],
  [
    'Locked forever',
    `The creator picks the split in ${CREATOR_SHARE_STEP_BPS / 100}% steps before launch. It is signed with the launch and written into the coin's metadata. Nobody can change it afterwards, not the creator and not Masked.`,
  ],
  [
    'Payouts',
    'Masked claims fees every hour and credits the creator share and each holder share. Holder shares are pro rata to balances; pools, burn and Masked wallets are excluded. Extra liquidity providers keep their own fees.',
  ],
  [
    'Claim in Monero or SOL',
    'Claim everything on My earnings, in native XMR sent to the Monero address you enter, or in SOL to your wallet. XMR claims are paid once a day at that day’s market rate minus a stated fee. If XMR payouts are delayed, your claim waits and is paid when they resume.',
  ],
  [
    'No accounts, no KYC',
    'You never sign up, verify an identity or share an email. A wallet signature is the only login, and we never ask for a recovery phrase.',
  ],
];

export default function Rules() {
  return (
    <Page>
      <Head>
        <title>{`How fees work | ${BRAND.name}`}</title>
      </Head>

      <header className="relative pb-10 pt-4 md:pb-14 md:pt-8">
        <p className="eyebrow">How fees work</p>
        <h1 className="mt-4 max-w-3xl font-display text-[32px] uppercase leading-[1.05] md:text-[54px]">
          <Decrypt text={`${pct(SCHEDULE.endingFeeBps)} flat.`} />
          <br />
          <span className="text-neutral-500">Before and after bonding.</span>
        </h1>
        <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-neutral-400">
          Every coin has the same fee. Meteora keeps {pct(split.meteoraBps)}, Masked keeps{' '}
          {pct(split.houseBps)} and {pct(split.buybackBps)} buys back and burns $MSKD. The creator
          splits the other {pct(split.beneficiaryBps)} with holders, locked forever at launch.
        </p>
      </header>

      {/* Split */}
      <section aria-labelledby="split" className="border-t border-neutral-850 pt-8">
        <h2 id="split" className="eyebrow">
          The creator&rsquo;s split
        </h2>
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          {EXAMPLES.map((creatorShareBps) => (
            <article key={creatorShareBps} className="surface flex flex-col p-6">
              <h3 className="font-display text-[15px] uppercase">
                {creatorShareBps === 0
                  ? 'All to holders'
                  : creatorShareBps === 10_000
                    ? 'All to the creator'
                    : 'Even split'}
              </h3>
              <p className="mt-6 font-pixel text-[32px] leading-none">
                {pct((split.beneficiaryBps * (10_000 - creatorShareBps)) / 10_000)}
              </p>
              <p className="mt-1.5 text-[13px] text-neutral-500">of every trade to holders</p>
              <FeeSplit mode={MASKED} creatorShareBps={creatorShareBps} compact className="mt-6" />
            </article>
          ))}
        </div>
        <p className="mt-4 max-w-3xl text-[12px] leading-relaxed text-neutral-500">
          Any {CREATOR_SHARE_STEP_BPS / 100}% step from 0 to 100% is allowed. Every coin card shows
          its split. Trades on Solana are public; a Monero claim keeps where your earnings go
          private.
        </p>
      </section>

      {/* Rules */}
      <section aria-labelledby="rules" className="mt-14 border-t border-neutral-850 pt-8">
        <h2 id="rules" className="eyebrow">
          The rules
        </h2>
        <dl className="mt-2 grid md:grid-cols-2 md:gap-x-12">
          {RULES.map(([title, copy]) => (
            <div key={title} className="border-b border-neutral-850 py-6">
              <dt className="font-display text-[13px] uppercase">{title}</dt>
              <dd className="mt-2 text-[14px] leading-relaxed text-neutral-400">{copy}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="mt-12 flex flex-col items-start justify-between gap-6 rounded-3xl border border-neutral-850 p-6 sm:flex-row sm:items-center md:p-8">
        <div>
          <p className="font-display text-[18px] uppercase">Ready when you are.</p>
          <p className="mt-1 text-[14px] text-neutral-500">Connect a wallet. Nothing else.</p>
        </div>
        <Link
          href="/launch"
          className="btn-holo inline-flex h-11 shrink-0 items-center gap-2 rounded-lg px-5 text-sm"
        >
          Launch a coin
          <span className="iconify h-4 w-4 ph--arrow-right" />
        </Link>
      </div>

      <p className="mt-8 max-w-3xl text-[12px] leading-relaxed text-neutral-500">
        Coins launched before Masked keep the fee policy they launched with; check each coin&rsquo;s
        live quote. Network fees and account rent are separate and shown before signing. Bonding is
        a goal, not a promise.
      </p>
    </Page>
  );
}
