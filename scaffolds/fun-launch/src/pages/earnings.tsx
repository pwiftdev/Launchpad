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
import { NETWORK } from '@/constants/network';
import { useCoins } from '@/hooks/useCoins';
import { adminPageRedirect } from '@/server/adminPage';
import { cn } from '@/lib/utils';
import { formatXmr, isMoneroAddress } from '@/lib/monero';
import {
  CURRENCY_LABEL,
  maskedClaimMessage,
  type ClaimCurrency,
  type EarningsView,
  type MaskedClaimView,
} from '@/lib/maskedEarnings';

export const getServerSideProps: GetServerSideProps = async (context) =>
  adminPageRedirect(context) ?? { props: {} };

const moneroNetwork = NETWORK === 'mainnet-beta' ? 'mainnet' : 'stagenet';
const sol = (lamports: string | bigint) => Number(BigInt(lamports)) / 1e9;
const formatSol = (lamports: string | bigint) =>
  `${sol(lamports).toLocaleString(undefined, { maximumFractionDigits: 6 })} SOL`;

const STATUS: Record<MaskedClaimView['status'], string> = {
  queued: 'Waiting for the daily payout',
  batched: 'In today’s payout',
  sent: 'Sent, confirming',
  paid: 'Paid',
  failed: 'Failed, earnings returned',
};

/** Every Masked creator and holder claims here, once, across all their coins. */
export default function Earnings() {
  const { publicKey, signMessage } = useWallet();
  const { setShowModal } = useUnifiedWalletContext();
  const client = useQueryClient();
  const wallet = publicKey?.toBase58();
  const { data: coins } = useCoins();
  const symbols = useMemo(
    () => new Map((coins ?? []).map((coin) => [coin.mint, coin.symbol])),
    [coins]
  );
  const earnings = useQuery<EarningsView>({
    queryKey: ['earnings', wallet],
    enabled: !!wallet,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/earnings?wallet=${wallet}`, { signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Earnings are unavailable');
      return body;
    },
    refetchInterval: 30_000,
  });
  const data = earnings.data;
  const [choice, setChoice] = useState<ClaimCurrency>('xmr');
  const [address, setAddress] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // XMR comes first; while native payouts are down, wXMR takes its place.
  const currency: ClaimCurrency = choice === 'sol' ? 'sol' : data?.wxmrAvailable ? 'wxmr' : 'xmr';
  const amount = data ? (currency === 'sol' ? data.solClaimableLamports : data.totalLamports) : '0';
  const addressValid = currency !== 'xmr' || isMoneroAddress(address.trim(), moneroNetwork);
  const belowMinimum =
    !!data && currency !== 'sol' && BigInt(data.totalLamports) < BigInt(data.minimumXmrLamports);
  const canClaim =
    !!data &&
    !data.openClaim &&
    BigInt(amount) > 0n &&
    addressValid &&
    !belowMinimum &&
    !submitting;

  async function claim() {
    if (!data || !wallet) return;
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
        ...(currency === 'xmr' ? { moneroAddress: address.trim() } : {}),
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
      toast.success(
        currency === 'sol'
          ? 'Claimed. Your SOL is on its way.'
          : 'Claimed. It goes out in the next daily payout.'
      );
      setAddress('');
      await client.invalidateQueries({ queryKey: ['earnings', wallet] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Claim failed');
    } finally {
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
        <h1 className="mt-4 font-display text-[30px] uppercase leading-[1.05] md:text-[44px]">
          <Decrypt text="Your earnings." />
          <br />
          <Decrypt text="Claimed in Monero." delay={160} className="text-holo" />
        </h1>
        <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-neutral-400">
          Creator shares and holder rewards from every Masked coin collect here. Claim them all at
          once, in native XMR or in SOL.
        </p>
      </header>

      {!wallet ? (
        <div className="surface p-6">
          <p className="text-sm text-neutral-400">
            Connect the wallet that launched or holds Masked coins.
          </p>
          <button
            type="button"
            onClick={() => setShowModal(true)}
            className="btn-holo mt-4 h-11 rounded-lg px-5 text-sm"
          >
            Connect wallet
          </button>
        </div>
      ) : earnings.isLoading ? (
        <div className="surface p-6 text-sm text-neutral-400">Loading your earnings…</div>
      ) : earnings.error || !data ? (
        <div className="surface p-6 text-sm text-rose" role="alert">
          {earnings.error instanceof Error ? earnings.error.message : 'Earnings are unavailable'}
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <section className="surface p-6" aria-labelledby="claimable">
            <p id="claimable" className="eyebrow">
              Ready to claim
            </p>
            <p className="mt-3 font-pixel text-[36px] leading-none">
              {formatSol(data.totalLamports)}
            </p>
            {data.coins.length > 0 && (
              <ul className="mt-5 divide-y divide-neutral-850 border-y border-neutral-850 text-sm">
                {data.coins.map((coin) => (
                  <li key={coin.mint} className="flex items-center gap-3 py-2.5">
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
            <section className="surface p-6">
              <p className="eyebrow">Your claim</p>
              <p className="mt-3 text-sm">
                {formatSol(data.openClaim.lamports)} in {CURRENCY_LABEL[data.openClaim.currency]}:{' '}
                <span className="font-semibold">{STATUS[data.openClaim.status]}</span>
              </p>
              <p className="mt-2 text-xs text-neutral-500">
                One claim at a time. New earnings wait here until it is paid.
              </p>
            </section>
          ) : (
            <section className="surface p-6" aria-labelledby="claim">
              <p id="claim" className="eyebrow">
                Claim
              </p>
              <div role="radiogroup" aria-label="Pay in" className="mt-4 grid gap-2 sm:grid-cols-2">
                {(['xmr', 'sol'] as const).map((option) => {
                  const label =
                    option === 'xmr' ? CURRENCY_LABEL[currency === 'wxmr' ? 'wxmr' : 'xmr'] : 'SOL';
                  const selected = option === 'sol' ? currency === 'sol' : currency !== 'sol';
                  return (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setChoice(option)}
                      className={cn(
                        'rounded-xl border p-3.5 text-left transition-colors',
                        selected
                          ? 'border-foreground bg-neutral-900'
                          : 'border-neutral-800 bg-neutral-950 hover:border-neutral-600'
                      )}
                    >
                      <span className="block text-sm font-semibold">{label}</span>
                      <span className="mt-1 block text-xs text-neutral-500">
                        {option === 'sol'
                          ? `${formatSol(data.solClaimableLamports)} now, to this wallet`
                          : currency === 'wxmr'
                            ? 'Native XMR payouts are down, so this pays wXMR to this wallet instead'
                            : data.xmrAvailable
                              ? 'Paid daily to your Monero address at that day’s rate'
                              : 'XMR payouts are delayed; your claim waits and pays when they resume'}
                      </span>
                    </button>
                  );
                })}
              </div>

              {currency === 'xmr' && (
                <div className="mt-4">
                  <label
                    htmlFor="monero-address"
                    className="mb-1.5 block text-sm font-medium text-neutral-300"
                  >
                    Monero address
                  </label>
                  <input
                    id="monero-address"
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={
                      moneroNetwork === 'mainnet' ? '4… or 8…' : 'Stagenet address 5… or 7…'
                    }
                    className="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3.5 py-2.5 font-mono text-xs text-foreground placeholder:text-neutral-600 focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  {address && !addressValid ? (
                    <p className="mt-1.5 text-xs text-rose" role="alert">
                      That is not a valid {moneroNetwork} Monero address.
                    </p>
                  ) : (
                    <p className="mt-1.5 text-xs text-neutral-500">
                      Use a fresh subaddress for each claim. We keep it encrypted and erase it once
                      the payout settles.
                    </p>
                  )}
                </div>
              )}

              {belowMinimum && (
                <p className="mt-4 text-xs text-neutral-500">
                  XMR claims start at {formatSol(data.minimumXmrLamports)} of earnings. Your
                  earnings keep collecting until then.
                </p>
              )}
              <button
                type="button"
                disabled={!canClaim}
                onClick={claim}
                className="btn-holo mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-xl text-[15px] disabled:opacity-50"
              >
                {submitting
                  ? 'Waiting for your signature…'
                  : `Claim ${formatSol(amount)} in ${CURRENCY_LABEL[currency]}`}
              </button>
            </section>
          )}

          {data.history.length > 0 && (
            <section className="surface p-6" aria-labelledby="history">
              <p id="history" className="eyebrow">
                Past claims
              </p>
              <ul className="mt-4 divide-y divide-neutral-850 text-sm">
                {data.history.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                    <span className="font-mono">{formatSol(item.lamports)}</span>
                    <span className="text-neutral-500">{CURRENCY_LABEL[item.currency]}</span>
                    {item.xmrAtomic && (
                      <span className="font-mono text-neutral-400">
                        {formatXmr(BigInt(item.xmrAtomic))} XMR
                      </span>
                    )}
                    <span className="ml-auto text-xs text-neutral-400">{STATUS[item.status]}</span>
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
