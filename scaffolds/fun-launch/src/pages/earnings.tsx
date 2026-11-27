import { useMemo, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useUnifiedWalletContext, useWallet } from '@jup-ag/wallet-adapter';
import { toast } from 'sonner';
import Page from '@/components/ui/Page/Page';
import { Decrypt } from '@/components/brand/Decrypt';
import { BRAND } from '@/constants/brand';
import { useCoins } from '@/hooks/useCoins';
import { adminPageRedirect } from '@/server/adminPage';
import { cn } from '@/lib/utils';
import { formatXmr } from '@/lib/monero';
import { formatSol } from '@/lib/tokenUnits';
import {
  CURRENCY_LABEL,
  formatWxmr,
  maskedClaimMessage,
  type SolanaClaimCurrency,
  type EarningsView,
  type MaskedClaimView,
} from '@/lib/maskedEarnings';

export const getServerSideProps: GetServerSideProps = async (context) =>
  adminPageRedirect(context) ?? { props: {} };

const STATUS: Record<MaskedClaimView['status'], string> = {
  queued: 'Waiting for payout',
  batched: 'In a payout batch',
  sent: 'Payout in progress',
  paid: 'Paid',
  failed: 'Payout failed',
};

const CLAIM_OPTIONS = ['wxmr', 'sol'] as const;

/** Every Masked creator and holder claims here, once, across all their coins. */
export default function Earnings() {
  const { publicKey, signMessage } = useWallet();
  const { setShowModal } = useUnifiedWalletContext();
  const client = useQueryClient();
  const wallet = publicKey?.toBase58();
  const [walletInput, setWalletInput] = useState('');
  const [lookupWallet, setLookupWallet] = useState<string | null>(null);
  const viewedWallet = lookupWallet ?? wallet;
  const ownsWallet = !!wallet && viewedWallet === wallet;
  const { data: coins } = useCoins();
  const symbols = useMemo(
    () => new Map((coins ?? []).map((coin) => [coin.mint, coin.symbol])),
    [coins]
  );
  const earnings = useQuery<EarningsView>({
    queryKey: ['earnings', viewedWallet],
    enabled: !!viewedWallet,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/earnings?wallet=${encodeURIComponent(viewedWallet!)}`, {
        signal,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Earnings are unavailable');
      return body;
    },
    refetchInterval: 30_000,
  });
  const data = earnings.data;
  const [currency, setCurrency] = useState<SolanaClaimCurrency>('wxmr');
  const [submitting, setSubmitting] = useState(false);
  const amount = data ? (currency === 'sol' ? data.solClaimableLamports : data.totalLamports) : '0';
  const wxmrPaused = currency === 'wxmr' && !data?.wxmrAvailable;
  const belowMinimum =
    !!data && currency === 'wxmr' && BigInt(amount) < BigInt(data.minimumWxmrLamports);
  const canClaim =
    ownsWallet &&
    !!data &&
    !data.openClaim &&
    BigInt(amount) > 0n &&
    !wxmrPaused &&
    !belowMinimum &&
    !submitting;

  async function claim() {
    if (!canClaim || !data || !wallet) return;
    if (!signMessage) {
      toast.error('Use a wallet that can sign messages');
      return;
    }
    setSubmitting(true);
    try {
      const request = {
        networkGenesis: data.networkGenesis,
        wallet,
        currency,
        lamports: amount,
        requestId: crypto.randomUUID(),
        issuedAt: Date.now(),
      };
      const signature = await signMessage(
        new TextEncoder().encode(maskedClaimMessage(window.location.origin, request))
      );
      const response = await fetch('/api/earnings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'claim',
          ...request,
          signature: Buffer.from(signature).toString('base64'),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Claim failed');
      toast.success('Claim submitted. Track your payout here.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Claim failed');
    } finally {
      await client.invalidateQueries({ queryKey: ['earnings', wallet] });
      setSubmitting(false);
    }
  }

  return (
    <Page containerClassName="max-w-3xl">
      <Head>
        <title>{`My earnings | ${BRAND.name}`}</title>
      </Head>
      <header className="pb-8 pt-4 md:pt-8">
        <p className="eyebrow">My earnings</p>
        <h1 className="mt-4 text-[30px] font-semibold leading-[1.02] tracking-[-0.045em] md:text-[44px]">
          <Decrypt text="Your earnings." />
          <br />
          <Decrypt text="Claim in wXMR." delay={160} className="text-holo" />
        </h1>
        <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-neutral-400">
          Creator shares and holder rewards from every Masked coin collect here. Claim them all at
          once in wrapped Monero (wXMR) or SOL to your connected wallet.
        </p>
        <p className="mt-2 text-sm text-neutral-400">
          Direct payouts to Monero wallets are in development.
        </p>
      </header>

      <form
        className="surface enter enter-1 mb-4 rounded-3xl p-5 sm:p-6"
        onSubmit={(event) => {
          event.preventDefault();
          const address = walletInput.trim();
          if (address) setLookupWallet(address);
        }}
      >
        <label htmlFor="earnings-wallet" className="text-[15px] font-semibold tracking-tight">
          Look up a Solana wallet
        </label>
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            id="earnings-wallet"
            placeholder="Solana wallet address"
            className="well h-11 min-w-0 flex-1 rounded-xl px-3.5 font-mono text-[13px] text-foreground outline-none transition-all duration-200 ease-out placeholder:font-sans placeholder:text-neutral-600 focus:border-primary/50 focus:shadow-[inset_0_1px_2px_rgba(0,0,0,0.35),0_0_0_4px_rgba(255,102,0,0.12)]"
            autoComplete="off"
            spellCheck={false}
            required
            maxLength={44}
            value={walletInput}
            onChange={(event) => setWalletInput(event.target.value)}
          />
          <button type="submit" className="btn-glass h-11 px-4 text-[13px]">
            View earnings
          </button>
        </div>
        {lookupWallet && (
          <button
            type="button"
            className="mt-3 inline-flex items-center gap-1 text-[13px] text-primary transition-opacity hover:opacity-80"
            onClick={() => {
              setLookupWallet(null);
              setWalletInput('');
            }}
          >
            {wallet ? 'Return to my earnings' : 'Clear wallet lookup'}
          </button>
        )}
      </form>

      {!viewedWallet ? (
        <div className="surface enter enter-2 flex flex-col items-center rounded-3xl px-6 py-10 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-b from-white/[0.12] to-white/[0.03] text-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_12px_28px_-12px_rgba(0,0,0,0.9)] ring-1 ring-inset ring-white/10">
            <span aria-hidden className="iconify h-6 w-6 ph--wallet-fill" />
          </span>
          <p className="mt-4 text-[15px] font-semibold">Connect to see your earnings</p>
          <p className="mt-1 max-w-sm text-sm text-neutral-400">
            Connect the wallet that launched or holds Masked coins.
          </p>
          <button
            type="button"
            onClick={() => setShowModal(true)}
            className="btn-holo mt-5 h-11 px-6 text-[14px]"
          >
            Connect wallet
          </button>
        </div>
      ) : earnings.isLoading ? (
        <div className="surface space-y-3 rounded-3xl p-6" aria-busy aria-label="Loading earnings">
          <div className="skeleton h-3 w-24" />
          <div className="skeleton h-10 w-56" />
          <div className="skeleton h-3 w-full" />
          <div className="skeleton h-3 w-2/3" />
        </div>
      ) : earnings.error || !data ? (
        <div className="surface rounded-3xl p-6 text-sm text-rose" role="alert">
          {earnings.error instanceof Error ? earnings.error.message : 'Earnings are unavailable'}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <section
            className="holo-border enter enter-2 overflow-hidden rounded-3xl p-6 sm:p-7"
            aria-labelledby="claimable"
          >
            <div
              aria-hidden
              className="pointer-events-none absolute -right-24 -top-28 -z-10 h-72 w-72 rounded-full bg-[radial-gradient(circle,rgba(255,110,20,0.28),transparent_65%)] blur-2xl"
            />
            <p id="claimable" className="eyebrow">
              Ready to claim
            </p>
            <p className="mt-3 font-mono text-[44px] font-semibold leading-none tracking-[-0.04em] sm:text-[52px]">
              {formatSol(data.totalLamports)}
            </p>
            {data.coins.length > 0 && (
              <ul className="mt-6 space-y-1.5 text-sm">
                {data.coins.map((coin) => (
                  <li
                    key={coin.mint}
                    className="tile tile-hover flex items-center gap-3 px-3.5 py-3"
                  >
                    <Link
                      href={`/token/${coin.mint}`}
                      className="w-28 shrink-0 truncate font-mono hover:text-primary"
                    >
                      ${symbols.get(coin.mint) ?? coin.mint.slice(0, 4)}
                    </Link>
                    <span className="flex-1 text-xs text-neutral-500">
                      {[
                        BigInt(coin.creatorLamports) > 0n ? 'creator share' : null,
                        coin.holderHours
                          ? `${coin.holderHours} hour${coin.holderHours === 1 ? '' : 's'} as holder`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    <span className="font-mono">
                      {formatSol(BigInt(coin.creatorLamports) + BigInt(coin.holderLamports))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {data.openClaim ? (
            <section className="surface enter enter-3 rounded-3xl p-6">
              <p className="eyebrow">{ownsWallet ? 'Your claim' : 'Pending claim'}</p>
              <p className="mt-3 text-sm">
                {formatSol(data.openClaim.lamports)} of earnings ·{' '}
                {CURRENCY_LABEL[data.openClaim.currency]} ·{' '}
                <span className="font-semibold">{STATUS[data.openClaim.status]}</span>
              </p>
              <p className="mt-2 text-xs text-neutral-500">
                {data.openClaim.failure ??
                  'One claim at a time. New earnings wait here until it finishes.'}
              </p>
            </section>
          ) : ownsWallet ? (
            <section className="surface enter enter-3 rounded-3xl p-6" aria-labelledby="claim">
              <p id="claim" className="eyebrow">
                Claim
              </p>
              <div role="radiogroup" aria-label="Pay in" className="mt-4 grid gap-2 sm:grid-cols-2">
                {CLAIM_OPTIONS.map((option) => {
                  const selected = currency === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setCurrency(option)}
                      className={cn(
                        'relative rounded-2xl border p-4 text-left transition-all duration-200 ease-out',
                        selected
                          ? 'border-primary/50 bg-primary/[0.08] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_0_4px_rgba(255,102,0,0.08),0_14px_30px_-16px_rgba(255,102,0,0.5)]'
                          : 'border-white/[0.08] bg-white/[0.03] hover:-translate-y-px hover:border-white/20'
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          'absolute right-3.5 top-3.5 grid h-5 w-5 place-items-center rounded-full transition-all duration-200 ease-spring',
                          selected
                            ? 'scale-100 bg-primary text-[#1a0900]'
                            : 'scale-90 ring-1 ring-inset ring-white/15'
                        )}
                      >
                        {selected && <span className="iconify h-3 w-3 ph--check-bold" />}
                      </span>
                      <span className="block text-[15px] font-semibold">
                        {CURRENCY_LABEL[option]}
                      </span>
                      <span className="mt-1 block text-xs text-neutral-500">
                        {option === 'sol'
                          ? `${formatSol(data.solClaimableLamports)} available in SOL`
                          : 'All eligible earnings converted at payout'}
                      </span>
                    </button>
                  );
                })}
              </div>

              {wxmrPaused ? (
                <p className="mt-4 text-xs text-neutral-400">
                  wXMR payouts are temporarily unavailable. Your earnings stay here.
                </p>
              ) : belowMinimum ? (
                <p className="mt-4 text-xs text-neutral-500">
                  wXMR claims start at {formatSol(data.minimumWxmrLamports)} of earnings. Your
                  earnings keep collecting until then.
                </p>
              ) : null}
              <button
                type="button"
                disabled={!canClaim}
                onClick={claim}
                className="btn-holo mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-2xl text-[15px] disabled:opacity-60"
              >
                {submitting
                  ? 'Waiting for your signature…'
                  : currency === 'wxmr'
                    ? 'Claim in wXMR'
                    : `Claim ${formatSol(amount)}`}
              </button>
            </section>
          ) : null}

          {data.history.length > 0 && (
            <section className="surface enter enter-4 rounded-3xl p-6" aria-labelledby="history">
              <p id="history" className="eyebrow">
                Past claims
              </p>
              <ul className="mt-4 space-y-1 text-sm">
                {data.history.map((item) => (
                  <li
                    key={item.id}
                    className="-mx-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-2 py-2.5 transition-colors duration-200 hover:bg-white/[0.035]"
                  >
                    <span className="font-mono">{formatSol(item.lamports)}</span>
                    <span className="text-neutral-500">{CURRENCY_LABEL[item.currency]}</span>
                    {item.status === 'paid' && item.xmrAtomic && (
                      <span className="font-mono text-neutral-400">
                        {item.currency === 'wxmr'
                          ? formatWxmr(item.xmrAtomic)
                          : `${formatXmr(BigInt(item.xmrAtomic))} XMR`}
                      </span>
                    )}
                    <span
                      className={cn(
                        'chip ml-auto',
                        item.status === 'paid' && 'border-emerald/25 bg-emerald/10 text-emerald',
                        item.status === 'failed' && 'border-rose/25 bg-rose/10 text-rose'
                      )}
                    >
                      {STATUS[item.status]}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Page>
  );
}
