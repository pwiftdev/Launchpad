import Head from 'next/head';
import Link from 'next/link';
import Page from '@/components/ui/Page/Page';
import { Decrypt } from '@/components/brand/Decrypt';
import { FeeSplit } from '@/components/fees/FeeSplit';
import { BRAND } from '@/constants/brand';
import { FEE_MODE_IDS, SCHEDULE, SPLIT, feeMode, pct } from '@/lib/feeModes';
export { requireAdminPage as getServerSideProps } from '@/server/adminPage';

const RULES: [string, string][] = [
  [
    'One-slot launch guard',
    `The slot a coin is created in charges ${pct(SCHEDULE.startingFeeBps)} on buys and sells, so bots cannot snipe it. From the next slot the fee is ${pct(SCHEDULE.endingFeeBps)}. The creator's first buy, bundled with creation, pays ${pct(SCHEDULE.endingFeeBps)}. Dynamic fees are off.`,
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
    'Payouts',
    'Fees are claimed by the house wallet and paid out in batches as they accrue. Creators request their share by signing a message. Holder payouts are pro rata to balances; pools, burn and house wallets are excluded. Extra liquidity providers keep their own fees.',
  ],
  [
    'No accounts, no KYC',
    'You never sign up, verify an identity or share an email. A wallet signature is the only login, and we never ask for a recovery phrase.',
  ],
  [
    'Anti-copy checks',
    'Ticker, name, artwork and source-post checks help protect existing launches from copies. They are best-effort moderation, not proof of ownership or token safety.',
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
          Every trade pays the same fee in every mode. Meteora keeps {pct(SPLIT.meteoraBps)}, the
          house keeps {pct(SPLIT.houseBps)}, and the mode you launch in decides who gets the other{' '}
          {pct(SPLIT.beneficiaryBps)}.
        </p>
      </header>

      {/* Modes */}
      <section aria-labelledby="modes" className="border-t border-neutral-850 pt-8">
        <h2 id="modes" className="eyebrow">
          Three modes
        </h2>
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          {FEE_MODE_IDS.map((id) => {
            const mode = feeMode(id);
            return (
              <article key={id} className="surface flex flex-col p-6">
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-[15px] uppercase">{mode.label}</h3>
                  <span className="rounded-md border border-neutral-800 px-1.5 py-0.5 font-mono text-[11px] text-neutral-400">
                    {mode.quoteSymbol}
                  </span>
                </div>
                <p className="mt-1.5 text-[13px] text-neutral-400">{mode.tagline}</p>
                <p className="mt-6 font-pixel text-[32px] leading-none">
                  {pct(SPLIT.beneficiaryBps)}
                </p>
                <p className="mt-1.5 text-[13px] text-neutral-500">
                  of every trade to {mode.beneficiary === 'creator' ? 'the creator' : 'holders'}
                  {mode.quote !== 'sol' ? `, paid in ${mode.payoutSymbol}` : ''}
                </p>
                <FeeSplit mode={mode} compact className="mt-6" />
              </article>
            );
          })}
        </div>
        <p className="mt-4 max-w-3xl text-[12px] leading-relaxed text-neutral-500">
          MSKD mode trades against SOL like every mode, but pays the holder share in wXMR, a
          Solana token issued by a bridge that holds Monero, and holders can cash out to real Monero.
          wXMR depends on that issuer: it can mint more and processes redemptions. Trades on Solana
          are public in every mode.
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
        Coins launched before these modes keep the fee policy they launched with; check each
        coin&rsquo;s live quote. Network fees and account rent are separate and shown before
        signing. Bonding is a goal, not a promise.
      </p>
    </Page>
  );
}
