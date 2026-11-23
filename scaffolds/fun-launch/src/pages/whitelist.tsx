import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { useUnifiedWalletContext, useWallet } from '@jup-ag/wallet-adapter';
import { toast } from 'sonner';
import { BRAND } from '@/constants/brand';
import {
  BASE_FEE_PERCENT,
  LAUNCH_TAX_CLIFF_PERCENT,
  LAUNCH_TAX_WINDOW_SECONDS,
} from '@/constants/launch';
import { LogoMark, Wordmark } from '@/components/brand/Logo';
import { ProfileEditorButton } from '@/components/profiles/ProfileEditor';
import { AnimatedNumber } from '@/components/ui/AnimatedNumber';
import { burstSparkles } from '@/lib/sparkles';
import { cn, shortenAddress } from '@/lib/utils';
import { parseReferralCode, type WhitelistInterest, type WhitelistReceipt } from '@/lib/whitelist';

const interests: { id: WhitelistInterest; label: string }[] = [
  { id: 'trader', label: 'Trade' },
  { id: 'creator', label: 'Launch' },
  { id: 'both', label: 'Both' },
];

const REF_KEY = 'rinsed.ref';
const countFormat = new Intl.NumberFormat('en-US');

async function whitelistRequest(body: object) {
  const response = await fetch('/api/whitelist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(result.error || 'Registration is temporarily unavailable. Please try again.');
  return result;
}

/** The referral code from ?ref=, remembered for the session so it survives connecting a wallet. */
function useReferralCode(): string | null {
  const { query, isReady } = useRouter();
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    if (!isReady) return;
    const fromUrl = parseReferralCode(query.ref);
    try {
      if (fromUrl) sessionStorage.setItem(REF_KEY, fromUrl);
      setCode(fromUrl ?? parseReferralCode(sessionStorage.getItem(REF_KEY)));
    } catch {
      setCode(fromUrl);
    }
  }, [isReady, query.ref]);
  return code;
}

export default function Whitelist() {
  const { publicKey, signMessage, disconnect } = useWallet();
  const { setShowModal } = useUnifiedWalletContext();
  const address = publicKey?.toBase58();
  const activeWallet = useRef(address);
  activeWallet.current = address;
  const registrationVersion = useRef(0);
  const referralCode = useReferralCode();
  const [interest, setInterest] = useState<WhitelistInterest>('both');
  const [receipt, setReceipt] = useState<WhitelistReceipt | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [invitedBy, setInvitedBy] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  // Count, inviter and (for a registered browser) the receipt for the connected wallet
  useEffect(() => {
    const controller = new AbortController();
    const version = registrationVersion.current;
    setReceipt(null);
    setError(null);
    setInvitedBy(null);
    const query = referralCode ? `?ref=${referralCode}` : '';
    fetch(`/api/whitelist${query}`, { signal: controller.signal, cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!data || controller.signal.aborted || version !== registrationVersion.current) return;
        if (typeof data.count === 'number') setCount(data.count);
        setInvitedBy(typeof data.invitedBy === 'string' ? data.invitedBy : null);
        if (address && data.registration?.wallet === address) setReceipt(data.registration);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [address, referralCode]);

  const joined = receipt && receipt.wallet === address && receipt.status !== 'revoked';

  async function join() {
    if (!address) return setShowModal(true);
    if (!signMessage) {
      setError('Choose a wallet that supports message signing.');
      return;
    }
    const joiningWallet = address;
    setBusy(true);
    setError(null);
    try {
      const challenge = await whitelistRequest({
        action: 'challenge',
        wallet: joiningWallet,
        interest,
        ...(referralCode ? { referralCode } : {}),
      });
      if (
        typeof challenge.message !== 'string' ||
        !challenge.message.startsWith('plzzz.bond — Mainnet early access\n') ||
        !challenge.message.includes(
          `Website: ${window.location.origin}\nWallet: ${joiningWallet}\n`
        ) ||
        activeWallet.current !== joiningWallet
      )
        throw new Error('Wallet or registration request changed. Please try again.');
      const signed = await signMessage(new TextEncoder().encode(challenge.message));
      if (activeWallet.current !== joiningWallet)
        throw new Error('Wallet changed. Please try again.');
      const signature = btoa(Array.from(signed, (byte) => String.fromCharCode(byte)).join(''));
      const result = await whitelistRequest({
        action: 'register',
        wallet: joiningWallet,
        nonce: challenge.nonce,
        signature,
      });
      if (activeWallet.current === joiningWallet) {
        registrationVersion.current += 1;
        setReceipt(result.registration);
        if (typeof result.count === 'number') setCount(result.count);
      }
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Registration was cancelled. You can try again.'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative isolate flex min-h-screen flex-col bg-background text-foreground">
      <Head>
        <title>{`$MSKD airdrop whitelist | ${BRAND.name}`}</title>
        <meta
          name="description"
          content="Join the whitelist for the $MSKD airdrop. Refer friends who join through your link to grow your airdrop. No payment or transaction required."
        />
        <meta key="og:title" property="og:title" content="Join the $MSKD airdrop whitelist." />
        <meta
          key="og:description"
          property="og:description"
          content="Whitelisters will receive a $MSKD airdrop. More successful referrals mean a bigger airdrop."
        />
        <link rel="canonical" href={`${BRAND.url}/whitelist`} />
      </Head>

      {/* One soft glow behind the mark */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed left-1/2 top-[30%] -z-10 h-[640px] w-[640px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgb(var(--primary)/0.10),transparent_62%)]"
      />

      <div className="relative z-10 flex flex-wrap items-center justify-center gap-3 border-b border-primary/15 bg-primary/5 px-4 py-3 text-center text-xs">
        <span className="text-neutral-300">
          The launchpad is open. Airdrop registration is optional.
        </span>
        <Link href="/" className="inline-flex items-center gap-1 font-semibold text-primary">
          Enter launchpad <span className="iconify h-3 w-3 ph--arrow-up-right" />
        </Link>
      </div>

      <main className="flex flex-1 flex-col items-center justify-center px-5 pb-10 pt-20 text-center">
        <div className="relative h-28 w-28" aria-hidden="true">
          <LogoMark halo animated className="h-full w-full" />
        </div>

        <h1 className="mt-6 max-w-full leading-none">
          <Wordmark className="text-[clamp(28px,8vw,40px)]" />
        </h1>
        <p className="mt-3 text-[15.5px] text-neutral-400 sm:text-[17px]">
          {BRAND.headline.top}{' '}
          <span className="font-medium text-foreground">{BRAND.headline.bottom}</span>
        </p>

        <section
          aria-label="$MSKD airdrop"
          className="mt-6 w-full max-w-[380px] rounded-2xl holo-border bg-panel px-5 py-4"
        >
          <p className="flex items-center justify-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-primary">
            <span className="iconify h-4 w-4 ph--gift" aria-hidden="true" />
            $MSKD airdrop
          </p>
          <h2 className="mt-2 font-display text-xl font-bold tracking-tight">
            Get whitelisted. Get $MSKD.
          </h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-neutral-400">
            Whitelisters will receive a $MSKD airdrop. The more friends join through your link,
            the bigger your airdrop.
          </p>
        </section>

        {count !== null && (
          <p
            className="mt-6 inline-flex items-center gap-2.5 text-sm text-neutral-400"
            aria-live="polite"
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald/60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald" />
            </span>
            <span>
              <AnimatedNumber
                value={count}
                format={(n) => countFormat.format(Math.round(n))}
                duration={900}
                className="font-semibold text-foreground tabular"
              />{' '}
              {count === 1 ? 'wallet' : 'wallets'} on the list
            </span>
          </p>
        )}

        <section
          aria-label="Whitelist registration"
          aria-live="polite"
          className="mt-10 w-full max-w-[380px]"
        >
          {joined ? (
            <Joined receipt={receipt} />
          ) : (
            <>
              {invitedBy && (
                <div className="mb-3.5 flex items-center gap-2.5 rounded-xl border border-acid/25 bg-acid/[0.07] px-3.5 py-2.5 text-left text-[13px] text-neutral-400">
                  <span className="shrink-0 rounded-md bg-acid/15 px-1.5 py-0.5 text-xs font-semibold text-acid">
                    Invited
                  </span>
                  <span>
                    Invited by <span className="font-medium text-foreground">{invitedBy}</span>.
                    Join the whitelist for the $MSKD airdrop.
                  </span>
                </div>
              )}

              <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-neutral-500">
                I’m here to
              </p>
              <div
                role="radiogroup"
                aria-label="I’m here to"
                className="grid grid-cols-3 gap-1 rounded-xl border border-neutral-850 bg-neutral-950 p-1"
              >
                {interests.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={interest === item.id}
                    disabled={busy}
                    onClick={() => setInterest(item.id)}
                    className={cn(
                      'rounded-lg py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                      interest === item.id
                        ? 'bg-neutral-850 text-foreground shadow-[inset_0_0_0_1px_rgb(var(--neutral-750))]'
                        : 'text-neutral-400 hover:text-foreground'
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              {address && (
                <div className="mt-3 flex items-center justify-between rounded-xl border border-neutral-850 px-3.5 py-2.5 text-[13px]">
                  <span className="flex items-center gap-2 tabular">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald shadow-[0_0_0_3px_rgb(var(--emerald)/0.15)]" />
                    {shortenAddress(address)}
                  </span>
                  <ProfileEditorButton />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => disconnect()}
                    className="font-medium text-neutral-400 hover:text-foreground"
                  >
                    Switch
                  </button>
                </div>
              )}

              <button
                type="button"
                disabled={busy || !ready}
                onClick={join}
                className="mt-3 inline-flex h-[50px] w-full items-center justify-center gap-2.5 btn-holo rounded-xl font-display text-sm font-bold transition-[filter,transform] active:scale-[0.985] disabled:cursor-progress disabled:brightness-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                {busy && <span className="iconify h-4 w-4 animate-spin ph--circle-notch" />}
                {busy ? 'Confirm in your wallet…' : address ? 'Sign to join' : 'Connect wallet'}
              </button>

              {error && (
                <p role="alert" className="mt-3 text-[13px] leading-relaxed text-rose">
                  {error}
                </p>
              )}
              <p className="mt-3.5 text-[12.5px] text-neutral-500">
                Signature only. No transaction, no SOL spent.{' '}
                <Link href="/privacy" className="text-neutral-400 underline underline-offset-2">
                  Privacy
                </Link>
              </p>
            </>
          )}
        </section>
        <p className="mx-auto mt-6 max-w-md text-center text-xs leading-relaxed text-neutral-500">
          Planned snipe tax: {LAUNCH_TAX_CLIFF_PERCENT}%, gradually reducing toward{' '}
          {BASE_FEE_PERCENT}% over up to {LAUNCH_TAX_WINDOW_SECONDS} seconds, or at graduation if
          the curve fills earlier. Trading is not open yet.
        </p>
      </main>

      <footer className="px-5 py-6 text-center text-xs text-neutral-500">
        © {BRAND.name}
        <Link href="/privacy" className="ml-3.5 hover:text-foreground">
          Privacy
        </Link>
        <a
          href={`https://x.com/${BRAND.xHandle.replace('@', '')}`}
          target="_blank"
          rel="noreferrer"
          className="ml-3.5 hover:text-foreground"
        >
          X ↗
        </a>
      </footer>
    </div>
  );
}

/** Success state: receipt, referral link and share. */
function Joined({ receipt }: { receipt: WhitelistReceipt }) {
  const title = useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState(BRAND.url);
  useEffect(() => {
    setOrigin(window.location.origin);
    burstSparkles(title.current, 14);
  }, []);

  const link = `${origin}/w/${receipt.referralCode}`;
  const shareText =
    'I joined the $MSKD airdrop whitelist Whitelisters will receive an airdrop, and more successful referrals mean a bigger share. Join through my link:';

  async function copy(button: HTMLButtonElement) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      burstSparkles(button, 10);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error('Could not copy the link.');
    }
  }

  return (
    <div data-registration-success="true">
      <h2 ref={title} className="font-display text-3xl font-black tracking-tight">
        You’re in.
      </h2>
      <p className="mt-2 text-[14.5px] text-neutral-400">
        Your wallet is on the whitelist for the $MSKD airdrop. This is the wallet we will use for
        your allocation.
      </p>
      <div className="mt-5 flex justify-between gap-3 rounded-xl border border-dashed border-neutral-750 px-3.5 py-3 text-[13px] text-neutral-400 tabular">
        <span>{shortenAddress(receipt.wallet)}</span>
        <span>
          Receipt{' '}
          <span className="font-medium text-foreground">
            {receipt.registrationId.slice(0, 8).toUpperCase()}
          </span>
        </span>
      </div>

      <div className="mt-5 rounded-2xl border border-neutral-850 bg-neutral-950 p-[18px] text-left">
        <h3 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
          Refer a friend
          <span className="rounded-md bg-primary/15 px-1.5 py-0.5 text-xs font-semibold text-primary">
            $MSKD airdrop
          </span>
        </h3>
        <p className="mt-1.5 text-[13.5px] text-neutral-400">
          Grow your $MSKD airdrop. The more friends join the whitelist through your link, the
          bigger your allocation.
        </p>
        <p className="mt-1 text-[12.5px] text-neutral-500">
          Allocation and distribution details will be announced. Claims are not open yet.
        </p>
        <div className="mt-3.5 flex items-center gap-1.5 rounded-none border border-neutral-750 bg-background py-[5px] pl-3 pr-[5px]">
          <code className="min-w-0 flex-1 truncate text-left font-sans text-[13.5px] font-medium">
            <span className="text-neutral-500">{origin.replace(/^https?:\/\//, '')}/w/</span>
            {receipt.referralCode}
          </code>
          <button
            type="button"
            onClick={(e) => copy(e.currentTarget)}
            className={cn(
              'h-9 min-w-[76px] shrink-0 rounded-lg px-3.5 text-[13.5px] font-semibold text-primary-950 transition-colors',
              copied ? 'bg-emerald' : 'bg-primary hover:brightness-110'
            )}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="mt-3 text-[12.5px] text-neutral-500">
          <span className="font-semibold text-foreground tabular">{receipt.referrals}</span>{' '}
          {receipt.referrals === 1 ? 'verified referral' : 'verified referrals'}
        </p>
      </div>

      <a
        href={`https://x.com/intent/post?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(link)}`}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-flex h-[50px] w-full items-center justify-center gap-2 btn-holo rounded-xl font-display text-sm font-bold"
      >
        <span className="iconify h-4 w-4 ph--x-logo-bold" />
        Share your link on X
      </a>
    </div>
  );
}
