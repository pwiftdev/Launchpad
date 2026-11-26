import React, { type ReactNode } from 'react';
import { OTC_EXPIRIES, OTC_FEE_RESERVE } from '@/lib/otc';
import { cn } from '@/lib/utils';
import { type OtcSettlement, otcFlowSteps } from './OtcHero';
import { OtcIcon, OtcSectionLink, OtcVisibility } from './OtcLayout';

const reserveSol = OTC_FEE_RESERVE / 1e9;
const expiries = Object.values(OTC_EXPIRIES)
  .join(', ')
  .replace(/, ([^,]*)$/, ' or $1');

/** Longer copy for each step of the rail above the desk. */
const DETAIL: Record<string, ReactNode> = {
  create: (
    <>
      Pick the asset you send and the asset you receive, then type the exact amount for each side.
      That pair of numbers is the price, so nothing can move against you between agreeing and
      settling. Choose an expiry of {expiries}. Add an invited wallet to make the offer visible to
      that wallet only.
    </>
  ),
  share: (
    <>
      Creating an offer gives you a private link. Send it through any channel you trust and treat it
      like a password: whoever holds it can review the terms unless you invited one wallet. Creating
      or sharing an offer never moves funds, and you can revoke it from <b>My offers</b> until a
      deal is opened.
    </>
  ),
  agree: (
    <>
      Your counterparty opens the link, checks what they send and receive, and signs the exact terms
      with their wallet. That signature is stored off-chain as the agreement. It is a message, not a
      transaction, so it costs nothing and moves nothing. The offer then shows as agreed on your
      desk.
    </>
  ),
  fund: (
    <>
      Each side signs an unlock message that opens a private deal wallet for this trade, then
      deposits its asset into it. Your wallet also sets aside {reserveSol} SOL for network fees and
      account rent. The deposit is a normal, public Solana transaction, and your wallet shows the
      total before you approve. New deposits pause in the final minute before the deadline.
    </>
  ),
  settle: (
    <>
      Once both deposits are finalized, each side prepares an encrypted transfer through Helius
      Privacy Rings. Either party then builds a single settlement transaction. Your deal wallet
      checks both amounts and recipients before you sign, and both signatures are required to submit
      it, so the two sides of the trade land together or not at all.
    </>
  ),
  withdraw: (
    <>
      After settlement finalizes, withdraw what you received to your connected wallet and reclaim
      any SOL left from the fee reserve. If the deadline passes before the swap settles, the same
      step returns your original deposit instead. Your deals stay on <b>My deals</b> so you can come
      back to finish at any time.
    </>
  ),
};

export function OtcExplainer({ settlement }: { settlement: OtcSettlement }) {
  const live = settlement === 'enabled';
  const steps = otcFlowSteps(settlement);
  const faqs: [string, ReactNode][] = [
    [
      'Why trade OTC instead of on the curve?',
      'Large orders move a bonding curve or pool against you, and everyone sees them land. An OTC trade happens at a price both sides fixed in advance, with one counterparty you chose, so there is no slippage and no price impact on the chart.',
    ],
    [
      'Does creating an offer cost anything or move funds?',
      'Creating an offer and signing the agreement are off-chain. The first on-chain transaction is a wallet funding the deal.',
    ],
    [
      'Who can see my offer?',
      'Anyone holding the link can review the terms. If you set an invited wallet, only that wallet can view and agree after signing in. Offers never appear on the board or in search.',
    ],
    [
      'How long does an offer last?',
      `You choose ${expiries}. When the deadline passes, the offer can no longer be agreed or funded. You can revoke an open offer at any time before a deal is opened.`,
    ],
    [
      'Which assets can I trade?',
      live
        ? 'SOL and USDC against each other, or a launchpad token paired with SOL or USDC. The desk checks that a token is eligible for Privacy Rings before you can offer it.'
        : 'SOL and USDC against each other.',
    ],
    ...(settlement
      ? ([
          [
            'What if my counterparty never funds?',
            'Nothing settles until both deposits are finalized and both wallets sign. If the deadline passes first, open the deal and withdraw your original deposit back to your wallet.',
          ],
          [
            'What is the deal wallet?',
            'A wallet opened from a message you sign with your own wallet, used only to hold your side of this deal. Signing the unlock message moves no funds. Sign it only on this site and never share the signature.',
          ],
          [
            `Why does funding need an extra ${reserveSol} SOL?`,
            'It covers network fees and account rent for the private transfer and settlement. You can return unused SOL after withdrawing. The first depositor for a launchpad token may also pay one-time rent for its shared Rings accounts.',
          ],
        ] as [string, ReactNode][])
      : []),
  ];

  return (
    <section
      id="otc-explainer"
      tabIndex={-1}
      aria-labelledby="otc-explainer-title"
      className="mt-16 scroll-mt-6 border-t border-neutral-850 pt-10 md:mt-20"
    >
      <p className="eyebrow">Walkthrough</p>
      <h2
        id="otc-explainer-title"
        className="mt-3 max-w-3xl font-display text-[26px] uppercase leading-[1.08] md:text-[40px]"
      >
        A private desk for <span className="whitespace-nowrap text-holo">one-to-one</span> trades.
      </h2>
      <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-neutral-400">
        Confidential OTC is for trades too large or too sensitive for the curve: a sale to a friend,
        a treasury rebalance, a fixed-price buy from a holder. You agree on terms in private and
        {live
          ? ' settle both sides together on Solana.'
          : ' keep a signed record of exactly what each side agreed to.'}
      </p>

      {/* Why */}
      <div className="mt-8 grid gap-px border border-white/[0.08] bg-white/[0.08] md:grid-cols-3">
        <Pillar icon="ph--target" title="Fixed price">
          Both amounts are set before anyone signs. No slippage, no front-running, no candle on the
          chart.
        </Pillar>
        <Pillar icon="ph--user-focus" title="One counterparty">
          A private link, optionally locked to a single wallet. Nothing is posted to the board.
        </Pillar>
        <Pillar
          icon={live ? 'ph--intersect-three' : 'ph--signature'}
          title={live ? 'Settles together' : 'Signed terms'}
        >
          {live
            ? 'One transaction swaps both sides, so neither party can take the other’s asset and walk.'
            : 'The counterparty signs the exact amounts and deadline, so there is no dispute about what was agreed.'}
        </Pillar>
      </div>

      {/* Steps */}
      <section aria-labelledby="otc-steps" className="mt-14">
        <h3 id="otc-steps" className="eyebrow">
          Step by step
        </h3>
        <ol className="mt-2">
          {steps.map((step, index) => (
            <li
              key={step.id}
              className="grid grid-cols-[3rem_minmax(0,1fr)] items-start gap-x-4 border-b border-neutral-850 py-6 md:grid-cols-[4.5rem_12rem_minmax(0,1fr)] md:gap-x-8"
            >
              <span className="font-pixel text-[28px] leading-none text-neutral-600 md:text-[34px]">
                {String(index + 1).padStart(2, '0')}
              </span>
              <h4 className="flex items-center gap-2 font-display text-[15px] uppercase md:pt-1.5">
                <OtcIcon name={step.icon} className="h-4 w-4 text-primary" />
                {step.title}
              </h4>
              <p className="col-start-2 mt-2 max-w-2xl text-[14px] leading-relaxed text-neutral-400 md:col-start-3 md:mt-0 md:pt-1">
                {DETAIL[step.id]}
              </p>
            </li>
          ))}
        </ol>
        {!live && (
          <p className="mt-4 max-w-2xl text-[12px] leading-relaxed text-neutral-500">
            {settlement === 'recovery'
              ? 'New settlements are paused on this deployment. Existing deals can still be opened to withdraw or recover eligible funds.'
              : 'Settlement is not available on this deployment. Agreements are a signed record of terms; funds move only if both sides complete the trade themselves.'}
          </p>
        )}
      </section>

      {/* Privacy */}
      <section
        id="otc-privacy"
        tabIndex={-1}
        aria-labelledby="otc-privacy-title"
        className="mt-14 scroll-mt-6"
      >
        <h3 id="otc-privacy-title" className="eyebrow">
          What stays private, and what doesn’t
        </h3>
        <div className="surface mt-4 overflow-x-auto">
          <table className="w-full min-w-[34rem] text-left text-sm">
            <thead className="border-b border-neutral-850 font-term text-[10px] uppercase tracking-[0.12em] text-neutral-500">
              <tr>
                <th scope="col" className="px-5 py-3 font-medium">
                  Part of the trade
                </th>
                <th scope="col" className="px-5 py-3 font-medium">
                  Visibility
                </th>
                <th scope="col" className="px-5 py-3 font-medium">
                  Who can see what
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-850">
              <PrivacyLine part="Offer terms and agreement" label="Off-chain">
                Stored by the desk, never on Solana. Visible to link holders, or only to the invited
                wallet.
              </PrivacyLine>
              {settlement && (
                <>
                  <PrivacyLine part="Deposits into deal wallets" label="Public">
                    Asset, amount and both wallet addresses appear on Solana like any transfer.
                  </PrivacyLine>
                  <PrivacyLine part="The swap itself" label="Encrypted">
                    Helius Privacy Rings hides the assets and amounts exchanged. Wallet addresses
                    stay visible.
                  </PrivacyLine>
                  <PrivacyLine part="Withdrawals" label="Public">
                    Asset, amount and destination wallet appear on Solana.
                  </PrivacyLine>
                </>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-3 max-w-3xl text-[12px] leading-relaxed text-neutral-500">
          {settlement
            ? 'Encryption covers the swap, not the edges. Someone watching both wallets can still match a public deposit to a public withdrawal of the other asset, so this is confidential settlement, not anonymity.'
            : 'The desk keeps the terms off-chain. Any transfer you make on Solana to complete the trade is public.'}{' '}
          No account, email or KYC is involved at any step.
        </p>
      </section>

      {/* FAQ */}
      <section aria-labelledby="otc-faq" className="mt-14">
        <h3 id="otc-faq" className="eyebrow">
          Questions
        </h3>
        <div className="mt-2 grid items-start md:grid-cols-2 md:gap-x-12">
          {faqs.map(([question, answer]) => (
            <details key={question} className="group border-b border-neutral-850">
              <summary className="flex cursor-pointer list-none items-start justify-between gap-4 py-5 font-display text-[13px] uppercase leading-snug transition-colors hover:text-primary [&::-webkit-details-marker]:hidden">
                {question}
                <OtcIcon
                  name="ph--plus"
                  className="mt-0.5 h-4 w-4 text-neutral-500 transition-transform group-open:rotate-45 group-open:text-primary"
                />
              </summary>
              <p className="-mt-1 pb-5 pr-8 text-[14px] leading-relaxed text-neutral-400">
                {answer}
              </p>
            </details>
          ))}
        </div>
      </section>

      <div className="mt-12 flex flex-col items-start justify-between gap-6 border border-neutral-850 p-6 sm:flex-row sm:items-center md:p-8">
        <div>
          <p className="font-display text-[18px] uppercase">Name your price.</p>
          <p className="mt-1 text-[14px] text-neutral-500">
            Connect a wallet, set the terms, send one link.
          </p>
        </div>
        <OtcSectionLink
          section="otc-desk"
          className="btn-holo inline-flex h-11 shrink-0 items-center gap-2 px-5 text-sm"
        >
          Create an offer
          <span className="iconify h-4 w-4 ph--arrow-up" />
        </OtcSectionLink>
      </div>
    </section>
  );
}

function Pillar({
  icon,
  title,
  children,
}: {
  icon: `ph--${string}`;
  title: string;
  children: ReactNode;
}) {
  return (
    <article className="bg-panel p-6">
      <OtcIcon name={icon} className="h-6 w-6 text-primary" />
      <h3 className="mt-4 font-display text-[15px] uppercase">{title}</h3>
      <p className="mt-2 text-[13px] leading-relaxed text-neutral-400">{children}</p>
    </article>
  );
}

function PrivacyLine({
  part,
  label,
  children,
}: {
  part: string;
  label: 'Off-chain' | 'Public' | 'Encrypted';
  children: ReactNode;
}) {
  return (
    <tr className={cn(label === 'Encrypted' && 'bg-primary/[0.04]')}>
      <th scope="row" className="px-5 py-4 align-top font-medium text-foreground">
        {part}
      </th>
      <td className="px-5 py-4 align-top">
        <OtcVisibility label={label} />
      </td>
      <td className="px-5 py-4 align-top text-[13px] leading-relaxed text-neutral-400">
        {children}
      </td>
    </tr>
  );
}
