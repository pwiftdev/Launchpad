import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { CoinAvatar } from '@/components/coin/CoinAvatar';
import { BondingBar } from '@/components/coin/BondingBar';
import { Button, buttonVariants } from '@/components/ui/button';
import { useCoin } from '@/hooks/useCoins';
import { useUsd } from '@/hooks/useUsd';
import { useWatchlist } from '@/hooks/useWatchlist';
import { NETWORK, NETWORK_LABEL, explorerUrl } from '@/constants/network';
import { BRAND } from '@/constants/brand';
import { burstSparkles } from '@/lib/sparkles';
import {
  clearPendingLaunch,
  finishLaunchRegistration,
  checkPendingLaunch,
  type PendingLaunch,
} from '@/lib/launchRegistration';
import type { LaunchPreparationContext } from '@/lib/launchPreparation';
import { useState } from 'react';

export type LaunchReceipt = Partial<LaunchPreparationContext> & {
  mint: string;
  name: string;
  symbol: string;
  image: string | null;
  signature: string | null;
  devBuyPercent: number;
  mode?: import('@/lib/launchModes').LaunchMode;
  registryStatus?: 'pending' | 'registered';
  wallet?: string;
};

type LaunchSuccessProps = { receipt: LaunchReceipt; preview?: boolean; onReset: () => void };
export function LaunchSuccess(props: LaunchSuccessProps) {
  // A receipt from another wallet/network/signature must never inherit confirmation
  // or expiry state from a prior receipt, even when the mint happens to match.
  const identity = JSON.stringify([
    props.receipt.genesis,
    props.receipt.wallet,
    props.receipt.mint,
    props.receipt.signature,
    props.receipt.mode,
  ]);
  return <LaunchSuccessContent key={identity} {...props} />;
}
function LaunchSuccessContent({ receipt, preview = false, onReset }: LaunchSuccessProps) {
  const { data: coin } = useCoin(receipt.mint);
  const { usd } = useUsd();
  const { add, toggle, isWatched } = useWatchlist();
  const initialized = useRef<string | null>(null);
  const celebration = useRef<HTMLSpanElement>(null);
  const watched = isWatched(receipt.mint);
  const [finishing, setFinishing] = useState(false);
  const [registeredMint, setRegisteredMint] = useState<string | null>(null);
  const pending =
    !preview && receipt.registryStatus !== 'registered' && registeredMint !== receipt.mint;
  const [safeRetry, setSafeRetry] = useState<'expired' | 'failed' | null>(null);
  async function finishRegistration() {
    if (!receipt.signature) return;
    setFinishing(true);
    try {
      const status = receipt.wallet
        ? await checkPendingLaunch(receipt as PendingLaunch).catch((): null => null)
        : null;
      if (status?.safeToRetry && (status.state === 'expired' || status.state === 'failed')) {
        setSafeRetry(status.state);
        return;
      }
      await finishLaunchRegistration(receipt.mint, receipt.signature, 60_000, receipt);
      setRegisteredMint(receipt.mint);
      toast.success('Launch registration finalized');
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Confirmation is still pending. Your token may already exist.'
      );
    } finally {
      setFinishing(false);
    }
  }
  async function clearVerifiedReceipt() {
    if (!receipt.wallet || !receipt.signature) return;
    setFinishing(true);
    try {
      const status = await checkPendingLaunch(receipt as PendingLaunch);
      if (!status.safeToRetry)
        throw new Error('Receipt is still pending. Keep it and check again.');
      clearPendingLaunch(receipt.mint, receipt.wallet, receipt.genesis);
      onReset();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not verify receipt expiry');
    } finally {
      setFinishing(false);
    }
  }
  const tokenPath = `/token/${encodeURIComponent(receipt.mint)}`;
  const tokenUrl = `${BRAND.url}${tokenPath}`;
  const shareUrl = `https://x.com/intent/tweet?${new URLSearchParams({
    text: `$${receipt.symbol} just launched on ${BRAND.name}.`,
    url: tokenUrl,
  })}`;

  useEffect(() => {
    if (preview || pending || initialized.current === receipt.mint) return;
    initialized.current = receipt.mint;
    add(receipt.mint, receipt);
    burstSparkles(celebration.current, 20);
  }, [preview, pending, receipt, add]);

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch {
      toast.error('Could not copy. Please copy it from the address bar.');
    }
  }

  return (
    <div className="space-y-5" data-launch-success={pending ? 'pending' : 'true'}>
      {pending && (
        <section className="rounded-xl border border-amber/30 bg-amber/5 p-4" role="status">
          <h2 className="font-semibold text-amber">
            {safeRetry === 'expired'
              ? 'Launch expired · no mint found'
              : safeRetry === 'failed'
                ? 'Finalized transaction failed · no mint found'
                : 'Launch pending · checking confirmation'}
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-neutral-400">
            {safeRetry === 'expired'
              ? 'The blockhash expired, retained history has no transaction, and the mint is absent. You may clear this receipt and prepare a new launch.'
              : safeRetry === 'failed'
                ? 'The transaction finalized with an error and the mint is absent. You may clear this receipt and prepare a new launch.'
                : 'Your public receipt is saved. Submission or finalization may still be pending. Check the original transaction before launching again; registration verifies the deployer and mode.'}
          </p>
          <Button
            className="mt-3"
            variant="outline"
            onClick={finishRegistration}
            disabled={finishing}
          >
            {finishing ? 'Checking finality…' : 'Check saved launch'}
          </Button>
          {safeRetry && (
            <Button
              className="ml-2 mt-3"
              variant="outline"
              disabled={finishing}
              onClick={clearVerifiedReceipt}
            >
              Clear verified receipt and retry
            </Button>
          )}
        </section>
      )}
      {preview && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber/25 bg-amber/5 px-4 py-3 text-sm text-amber"
        >
          <span>Post-launch preview · no token created. Stats below are sample data.</span>
          <Link href="/launch" className="font-medium underline underline-offset-4">
            Exit preview
          </Link>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-neutral-400 hover:text-foreground"
        >
          <span className="iconify h-4 w-4 ph--arrow-left" /> Back to the board
        </Link>
        <span className="rounded-full border border-neutral-800 px-3 py-1 text-xs text-neutral-400">
          Solana {NETWORK_LABEL}
        </span>
      </div>

      <section
        className="relative isolate overflow-hidden rounded-2xl border border-primary/20 bg-neutral-950 p-6 md:p-9"
        aria-label={pending ? 'Launch pending' : 'Launch complete'}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-20 -top-40 h-[520px] w-[520px] rounded-full bg-primary/10 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-32 right-16 h-80 w-80 rounded-full border border-primary/10"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-24 right-24 h-64 w-64 rounded-full border border-primary/10"
        />
        <div className="relative grid items-center gap-8 lg:grid-cols-[1fr_300px]">
          <div>
            <span
              ref={celebration}
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium ${pending ? 'border-amber/25 bg-amber/10 text-amber' : 'border-emerald/25 bg-emerald/10 text-emerald'}`}
            >
              <span
                className={`iconify h-3.5 w-3.5 ${pending ? 'ph--clock' : 'ph--check-circle-fill'}`}
              />
              {preview
                ? 'Launch complete · preview'
                : pending
                  ? 'Launch signed · checking submission'
                  : 'Launch confirmed'}
            </span>
            <div className="mt-7 flex flex-col items-start gap-5 sm:flex-row sm:items-center">
              <div className="relative rounded-2xl border border-white/10 bg-white/5 p-2 shadow-xl">
                <CoinAvatar
                  image={receipt.image}
                  symbol={receipt.symbol}
                  className="h-28 w-28 rounded-xl text-5xl md:h-32 md:w-32"
                />
                <span
                  className={`absolute -bottom-2 -right-2 flex h-8 w-8 items-center justify-center rounded-full border-4 border-neutral-950 ${pending ? 'bg-amber' : 'bg-emerald'} text-neutral-950`}
                >
                  <span className={`iconify h-4 w-4 ${pending ? 'ph--clock' : 'ph--check-bold'}`} />
                </span>
              </div>
              <div className="min-w-0">
                <p className="mb-1 truncate text-sm text-neutral-400">{receipt.name}</p>
                <h1 className="break-words text-3xl font-semibold tracking-tight md:text-5xl">
                  ${receipt.symbol}
                  <br />
                  <span className="text-primary">{pending ? 'is being checked.' : 'is live.'}</span>
                </h1>
              </div>
            </div>
            <p className="mt-6 max-w-lg text-sm leading-relaxed text-neutral-400">
              {pending
                ? 'Keep this receipt while the original launch is checked. A pending receipt does not prove that the token is live.'
                : 'Your coin has a home. Follow the first trades, share it with your community, and watch the launch unfold.'}
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href={tokenPath} className={buttonVariants({ size: 'lg' })}>
                <span className="iconify h-4 w-4 ph--chart-line-up" /> View token
                <span className="iconify h-4 w-4 ph--arrow-up-right" />
              </Link>
              <Button
                size="lg"
                variant="outline"
                onClick={() => copy(`${window.location.origin}${tokenPath}`, 'Token link')}
              >
                <span className="iconify h-4 w-4 ph--link" /> Copy token link
              </Button>
            </div>
          </div>

          <div className="rounded-xl border border-neutral-800 bg-background/70 p-5 backdrop-blur-sm">
            <p className="eyebrow">Launch receipt</p>
            <div className="mt-5 flex items-center gap-3 border-b border-neutral-800 pb-5">
              <span
                className={`flex h-10 w-10 items-center justify-center rounded-xl ${pending ? 'bg-amber/10 text-amber' : 'bg-emerald/10 text-emerald'}`}
              >
                <span className={`iconify h-5 w-5 ${pending ? 'ph--clock' : 'ph--shield-check'}`} />
              </span>
              <div>
                <p className="text-sm font-medium">
                  {preview
                    ? 'Sample confirmation'
                    : pending
                      ? 'Confirmation pending'
                      : 'Confirmed on Solana'}
                </p>
                <p className="mt-0.5 text-xs text-neutral-500">
                  {preview
                    ? 'Read-only design preview'
                    : pending
                      ? 'Checking the saved transaction'
                      : 'Your launch transaction succeeded'}
                </p>
              </div>
            </div>
            <dl className="mt-5 space-y-4 text-xs">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-neutral-500">Network</dt>
                <dd>Solana {NETWORK_LABEL}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-neutral-500">Token mint</dt>
                <dd>
                  <button
                    type="button"
                    disabled={preview}
                    onClick={() => copy(receipt.mint, 'Mint address')}
                    aria-label="Copy mint address"
                    className="flex items-center gap-2 font-mono text-neutral-300 hover:text-primary disabled:cursor-default"
                  >
                    {preview
                      ? 'Sample token'
                      : `${receipt.mint.slice(0, 6)}…${receipt.mint.slice(-6)}`}
                    <span className="iconify h-3.5 w-3.5 ph--copy" />
                  </button>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-neutral-500">Transaction</dt>
                <dd>
                  {receipt.signature && !preview ? (
                    <a
                      href={explorerUrl(`tx/${receipt.signature}`)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      View on Solscan <span className="iconify h-3 w-3 ph--arrow-up-right" />
                    </a>
                  ) : (
                    <span className="text-neutral-500">Preview only</span>
                  )}
                </dd>
              </div>
            </dl>
            <button
              type="button"
              onClick={() => (watched ? toggle(receipt.mint) : add(receipt.mint, receipt))}
              aria-pressed={watched}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg border border-neutral-800 py-2.5 text-xs text-neutral-300 transition-colors hover:border-primary/40 hover:text-primary"
            >
              <span
                className={`iconify h-4 w-4 ${watched ? 'ph--star-fill text-amber' : 'ph--star'}`}
              />
              {watched ? 'Saved in your starred bar' : 'Save to starred bar'}
            </button>
          </div>
        </div>
      </section>

      <section
        aria-label={preview ? 'Sample launch stats' : 'Live launch stats'}
        className="grid gap-3 sm:grid-cols-3"
      >
        <div className="surface p-5">
          <p className="text-xs text-neutral-500">
            {preview ? 'Sample market cap' : 'Live market cap'}
          </p>
          <p className="mt-2 font-mono text-2xl font-medium tabular">
            {coin ? usd(coin.marketCapSol) : '—'}
          </p>
          <p className="mt-2 text-xs text-neutral-500">
            {coin ? 'Updates as trading happens' : 'Waiting for market data'}
          </p>
        </div>
        <div className="surface p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-neutral-500">Bonding progress</p>
            <span className="font-mono text-xs text-primary">
              {coin ? `${Math.round((coin.isMigrated ? 1 : coin.progress) * 100)}%` : '—'}
            </span>
          </div>
          <div className="mt-4">
            {coin ? (
              <BondingBar progress={coin.progress} isMigrated={coin.isMigrated} />
            ) : (
              <div className="h-2 rounded-full bg-neutral-850" />
            )}
          </div>
          <p className="mt-4 text-xs text-neutral-500">
            {coin?.isMigrated ? 'Graduated to the open market' : 'Track the path to graduation'}
          </p>
        </div>
        <div className="surface p-5">
          <p className="text-xs text-neutral-500">Creator buy selected at launch</p>
          <p className="mt-2 font-mono text-2xl font-medium tabular">
            {receipt.devBuyPercent}%{' '}
            <span className="text-xs font-normal text-neutral-500">of supply</span>
          </p>
          <p className="mt-2 text-xs text-neutral-500">Current balances are on the token page</p>
        </div>
      </section>

      <div className="grid gap-3 md:grid-cols-2">
        <section className="surface flex items-start gap-4 p-5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <span className="iconify h-5 w-5 ph--megaphone" />
          </span>
          <div>
            <h2 className="text-sm font-medium">Give your coin its first hello</h2>
            <p className="mt-1 text-xs leading-relaxed text-neutral-500">
              Share the token page so your community can find the right coin.
            </p>
            {preview || pending ? (
              <p className="mt-3 text-xs text-neutral-500">Sharing unlocks after a real launch.</p>
            ) : (
              <a
                href={shareUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-2 text-sm text-primary hover:underline"
              >
                Share on X <span className="iconify h-3.5 w-3.5 ph--arrow-up-right" />
              </a>
            )}
          </div>
        </section>
        <section className="surface flex items-start gap-4 p-5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber/10 text-amber">
            <span className="iconify h-5 w-5 ph--star" />
          </span>
          <div>
            <h2 className="text-sm font-medium">Keep it close</h2>
            <p className="mt-1 text-xs leading-relaxed text-neutral-500">
              Your starred bar stays at the top as you explore. Everything you follow, one click
              away.
            </p>
            <Link
              href="/?watchlist=1"
              className="mt-3 inline-flex items-center gap-2 text-sm text-primary hover:underline"
            >
              Explore the board <span className="iconify h-3.5 w-3.5 ph--arrow-right" />
            </Link>
          </div>
        </section>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 pt-1 text-xs text-neutral-500">
        <span>
          {NETWORK !== 'mainnet-beta'
            ? `${NETWORK_LABEL} launch · test tokens and SOL have no real-world value.`
            : 'Market data may take a moment to appear.'}
        </span>
        <button
          type="button"
          onClick={onReset}
          disabled={pending}
          className="inline-flex items-center gap-1.5 text-neutral-300 hover:text-primary"
        >
          <span className="iconify h-3.5 w-3.5 ph--plus" /> Launch another coin
        </button>
      </div>
    </div>
  );
}
