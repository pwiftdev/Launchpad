import { useEffect, useMemo, useRef, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useQueryClient } from '@tanstack/react-query';
import { Keypair, Transaction } from '@solana/web3.js';
import { useUnifiedWalletContext, useWallet } from '@jup-ag/wallet-adapter';
import { toast } from 'sonner';
import Page from '@/components/ui/Page/Page';
import { Button } from '@/components/ui/button';
import { LaunchSuccess, type LaunchReceipt } from '@/components/launch/LaunchSuccess';
import { LaunchPreviewCard } from '@/components/launch/LaunchPreviewCard';
import type { GetServerSideProps } from 'next';
import { BRAND } from '@/constants/brand';
import {
  BASE_FEE_PERCENT,
  DEV_BUY_MAX_PERCENT_OF_SUPPLY,
  LAUNCH_IMAGE_MAX_BYTES,
  LAUNCH_IMAGE_MAX_MB,
  TICKER_CHARACTERS,
  TOTAL_SUPPLY,
} from '@/constants/launch';
import { useUsd } from '@/hooks/useUsd';
import { getDemoCoin } from '@/lib/demo';
import {
  DEFAULT_CREATOR_SHARE_BPS,
  LAUNCH_FEE_MODE,
  SCHEDULE,
  SPLIT,
  feeMode,
  pct,
  type FeeMode,
  type FeeModeId,
} from '@/lib/feeModes';
import { CreatorSharePicker } from '@/components/launch/CreatorSharePicker';
import { Decrypt } from '@/components/brand/Decrypt';
import { FeeSplit } from '@/components/fees/FeeSplit';
import { formatReadableNumber } from '@/lib/format/number';
import { cn } from '@/lib/utils';
import { launchMessage, type LaunchPayload } from '@/lib/launchAuth';
import {
  finishLaunchRegistration,
  pendingLaunchFor,
  preparedLaunchMessage,
  submitPreparedLaunch,
} from '@/lib/launchRegistration';
import { NETWORK, NETWORK_LABEL } from '@/constants/network';
import {
  normalizeSocial,
  normalizeSocials,
  SOCIAL_KINDS,
  SOCIAL_LABELS,
  socialMaxLength,
  hasSocials,
  type SocialKind,
} from '@/lib/socials';
import { SOCIAL_ICONS } from '@/components/coin/SocialLinks';
import { adminPageRedirect } from '@/server/adminPage';
import { readLaunchImage } from '@/lib/launchImageFile';

export const getServerSideProps: GetServerSideProps = async (context) =>
  adminPageRedirect(context) ?? { props: {} };

type DevBuyQuote = { tokens: number; costQuote: number; feeQuote: number; quoteSymbol: string };

const EMPTY_LINKS: Record<SocialKind, string> = {
  website: '',
  twitter: '',
  telegram: '',
  discord: '',
};
const LINK_PLACEHOLDERS: Record<SocialKind, string> = {
  website: 'maskedfrog.xyz',
  twitter: '@maskedfrog or https://x.com/…',
  telegram: 't.me/maskedfrog',
  discord: 'discord.gg/maskedfrog',
};

export default function Launch() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { publicKey, signTransaction, signMessage } = useWallet();
  const { setShowModal } = useUnifiedWalletContext();

  const [name, setName] = useState('');
  const [ticker, setTicker] = useState('');
  const [description, setDescription] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [links, setLinks] = useState(EMPTY_LINKS);
  const mode = LAUNCH_FEE_MODE;
  const selectedMode = feeMode(mode);
  const [creatorShareBps, setCreatorShareBps] = useState(DEFAULT_CREATOR_SHARE_BPS);
  const availability = useLaunchAvailability(mode);
  const [devBuyPercent, setDevBuyPercent] = useState(0);
  const devBuy = useDevBuyQuote(devBuyPercent, mode);
  const { usd, price } = useUsd();

  const [submitting, setSubmitting] = useState(false);
  const launchLock = useRef(false);
  const [launched, setLaunched] = useState<LaunchReceipt | null>(null);
  useEffect(() => {
    if (!publicKey) {
      setLaunched(null);
      return;
    }
    const pending = pendingLaunchFor(publicKey.toBase58(), availability.data?.genesis);
    setLaunched((current) =>
      pending
        ? { ...pending, registryStatus: 'pending' }
        : current?.wallet === publicKey.toBase58() &&
            (!availability.data?.genesis || current.genesis === availability.data.genesis)
          ? current
          : null
    );
  }, [publicKey, availability.data?.genesis]);
  const previewReceipt = useMemo<LaunchReceipt | null>(() => {
    const coin = router.query.preview === 'success' ? getDemoCoin('demo-bubble-cat') : undefined;
    return coin
      ? {
          mint: coin.mint,
          name: coin.name,
          symbol: coin.symbol,
          image: coin.image,
          signature: null,
          devBuyPercent: 0,
        }
      : null;
  }, [router.query.preview]);
  const receipt = launched ?? previewReceipt;

  function clearMetadata() {
    setName('');
    setTicker('');
    setDescription('');
    setImage(null);
    setLinks(EMPTY_LINKS);
    setDevBuyPercent(0);
    setCreatorShareBps(DEFAULT_CREATOR_SHARE_BPS);
  }

  function resetLaunch() {
    setLaunched(null);
    clearMetadata();
    if (previewReceipt) void router.replace('/launch');
  }

  useEffect(() => {
    if (!image) {
      setImagePreview(null);
      return undefined;
    }
    const url = URL.createObjectURL(image);
    setImagePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  const errors = {
    name:
      name.trim().length === 0
        ? 'Give your coin a name'
        : name.length > 32
          ? 'Max 32 characters'
          : null,
    ticker: !TICKER_CHARACTERS.test(ticker)
      ? 'Add a ticker with a letter or number'
      : ticker.length > 10
        ? 'Max 10 characters'
        : null,
  };
  const linkErrors = Object.fromEntries(
    SOCIAL_KINDS.map((kind) => [
      kind,
      links[kind].trim() && !normalizeSocial(kind, links[kind])
        ? kind === 'website'
          ? 'Enter a website address'
          : kind === 'twitter'
            ? 'Enter an X handle or link'
            : kind === 'telegram'
              ? 'Use a t.me link'
              : 'Use a discord.gg invite'
        : null,
    ])
  ) as Record<SocialKind, string | null>;
  const socials = normalizeSocials(links);
  const isValid = !Object.values(errors).some(Boolean) && !Object.values(linkErrors).some(Boolean);
  const creationFee = availability.data?.poolCreationFeeSol ?? 0;
  const totalCost = creationFee + (devBuyPercent > 0 ? (devBuy.data?.costQuote ?? 0) : 0);

  async function draftFromForm() {
    if (!isValid || !image) throw new Error('Add a valid name, ticker and artwork first.');
    return {
      tokenLogo: await readLaunchImage(image),
      tokenName: name.trim(),
      tokenSymbol: ticker.trim().replace(/^\$+/, '').toUpperCase(),
      devBuyPercent,
      description: description.trim() || undefined,
      socials: hasSocials(socials) ? socials : undefined,
      mode,
      creatorShareBps,
    };
  }

  async function launch() {
    if (launchLock.current) return;
    if (!publicKey || !signTransaction) return setShowModal(true);
    if (!availability.data?.canLaunch)
      return toast.error(
        availability.notice ?? 'A reviewed launch configuration is required before testing launches'
      );
    if (!isValid || !image) return toast.error('Fill in the highlighted fields first');
    const previous = pendingLaunchFor(publicKey.toBase58(), availability.data.genesis);
    if (previous) {
      setLaunched({ ...previous, registryStatus: 'pending' });
      return toast.message('Check your saved launch before preparing another');
    }
    launchLock.current = true;
    setSubmitting(true);
    try {
      if (!signMessage) throw new Error('Use a wallet that supports signing launch authorizations');
      const mintKeypair = Keypair.generate();
      const payload: LaunchPayload = {
        ...(await draftFromForm()),
        mint: mintKeypair.publicKey.toBase58(),
        userWallet: publicKey.toBase58(),
        burnShare: 0,
        configKey: availability.data.configKey,
      };
      const issuedAt = Date.now();
      const message = await launchMessage(payload, window.location.origin, issuedAt);
      const authorization = await signMessage(new TextEncoder().encode(message));

      const uploadResponse = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          issuedAt,
          signature: Buffer.from(authorization).toString('base64'),
        }),
      });
      const upload = await uploadResponse.json();
      if (!uploadResponse.ok) throw new Error(upload.error);

      const transaction = Transaction.from(Buffer.from(upload.poolTx, 'base64'));
      const prepared = preparedLaunchMessage(transaction, upload, availability.data.genesis);
      transaction.partialSign(mintKeypair);
      const signed = await signTransaction(transaction);
      const submitted = await submitPreparedLaunch({
        signed,
        expectedMessage: prepared.message,
        receipt: {
          mint: payload.mint,
          name: payload.tokenName,
          symbol: payload.tokenSymbol,
          image: typeof upload.imageUrl === 'string' ? upload.imageUrl : null,
          devBuyPercent,
          mode,
          wallet: publicKey.toBase58(),
          ...prepared.context,
        },
        onSaved: (receipt) => setLaunched({ ...receipt, registryStatus: 'pending' }),
      });
      const pendingReceipt = submitted.receipt;
      if (!submitted.relayAccepted)
        toast.message('Your receipt is saved; submission is being checked');
      try {
        await finishLaunchRegistration(
          payload.mint,
          pendingReceipt.signature,
          60_000,
          pendingReceipt
        );
        setLaunched({ ...pendingReceipt, registryStatus: 'registered' });
        toast.success(`${ticker.toUpperCase()} is live and registered. Now push it to bond.`);
      } catch (registrationError) {
        toast.message('Your launch receipt is saved', {
          description:
            registrationError instanceof Error
              ? registrationError.message
              : 'Retry confirmation without launching again.',
        });
      }
      for (const key of ['coins', 'trending', 'market-stats']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      console.error('Launch failed:', error);
      toast.error(error instanceof Error ? error.message : 'Launch failed');
    } finally {
      launchLock.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Page>
      <Head>
        <title>
          {receipt
            ? `$${receipt.symbol} ${receipt.registryStatus === 'registered' ? 'launched' : 'launch pending'} | ${BRAND.name}`
            : `Launch a coin | ${BRAND.name}`}
        </title>
      </Head>

      {!receipt && (
        <header className="relative mb-8 pt-2 md:mb-10 md:pt-6">
          <p className="eyebrow">Launch</p>
          <h1 className="mt-4 text-[30px] font-semibold leading-[1.02] tracking-[-0.045em] md:text-[46px]">
            <Decrypt text="Launch a coin." />
            <br />
            <Decrypt text="Pay your holders." delay={160} className="text-holo" />
          </h1>
          <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-neutral-400">
            {NETWORK === 'mainnet-beta'
              ? 'Create a coin on Solana Mainnet. Network fees use SOL.'
              : `Create a test coin on ${NETWORK_LABEL}. Test-network SOL has no real-world value.`}{' '}
            {pct(SCHEDULE.endingFeeBps)} flat after the {pct(SCHEDULE.startingFeeBps)} launch slot,
            before and after bonding.
          </p>
        </header>
      )}

      {receipt ? (
        <LaunchSuccess receipt={receipt} preview={!launched} onReset={resetLaunch} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
          <form
            className="flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              launch();
            }}
            noValidate
          >
            <Step n={1} title="Your coin">
              <div className="grid gap-5 md:grid-cols-[1fr_180px]">
                <div className="flex flex-col gap-4">
                  <Field label="Name" htmlFor="name" error={name ? errors.name : null}>
                    <input
                      id="name"
                      className={inputClass}
                      placeholder="e.g. Masked Frog"
                      value={name}
                      maxLength={32}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </Field>
                  <Field label="Ticker" htmlFor="ticker" error={ticker ? errors.ticker : null}>
                    <div className="relative">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-neutral-500">
                        $
                      </span>
                      <input
                        id="ticker"
                        className={cn(inputClass, 'pl-7 font-mono uppercase')}
                        placeholder="MASK"
                        value={ticker}
                        maxLength={10}
                        onChange={(e) => setTicker(e.target.value.replace(/^\$+/, ''))}
                      />
                    </div>
                  </Field>
                  <Field
                    label="Description"
                    optional
                    htmlFor="description"
                    hint={`${description.length}/500 · Tell traders what your coin is about.`}
                  >
                    <textarea
                      id="description"
                      className={cn(inputClass, 'min-h-24 resize-y')}
                      placeholder="The story behind your coin…"
                      value={description}
                      maxLength={500}
                      onChange={(e) => setDescription(e.target.value)}
                    />
                  </Field>
                </div>
                <ImageDrop preview={imagePreview} onFile={setImage} />
              </div>
            </Step>

            <Step
              n={2}
              title="Links"
              optional
              subtitle="Written into your token metadata, so wallets, explorers and DEX screeners show them too."
            >
              <div className="grid gap-4 sm:grid-cols-2">
                {SOCIAL_KINDS.map((kind) => (
                  <Field
                    key={kind}
                    label={SOCIAL_LABELS[kind]}
                    htmlFor={`link-${kind}`}
                    error={linkErrors[kind]}
                  >
                    <div className="relative">
                      <span
                        className={cn(
                          'iconify pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500',
                          SOCIAL_ICONS[kind]
                        )}
                      />
                      <input
                        id={`link-${kind}`}
                        inputMode="url"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={socialMaxLength(kind)}
                        className={cn(inputClass, 'pl-9')}
                        placeholder={LINK_PLACEHOLDERS[kind]}
                        value={links[kind]}
                        onChange={(e) =>
                          setLinks((current) => ({ ...current, [kind]: e.target.value }))
                        }
                        onBlur={() => {
                          const link = normalizeSocial(kind, links[kind]);
                          if (link) setLinks((current) => ({ ...current, [kind]: link }));
                        }}
                      />
                    </div>
                  </Field>
                ))}
              </div>
            </Step>

            <Step
              n={3}
              title="Fee split"
              subtitle={`${pct(SCHEDULE.endingFeeBps)} flat, before and after bonding. You decide how ${pct(SPLIT.beneficiaryBps)} of every trade splits between you and your holders.`}
            >
              <CreatorSharePicker value={creatorShareBps} onChange={setCreatorShareBps} />
              <FeeSplit mode={selectedMode} creatorShareBps={creatorShareBps} className="mt-5" />
              <p className="mt-3 text-xs leading-relaxed text-neutral-500">
                Masked collects fees every hour and credits your share and each holder&rsquo;s
                share. Holder shares are pro rata to balances; pools, burn and Masked wallets are
                excluded. Everyone claims in wXMR or SOL. Bonding is not guaranteed.
              </p>
            </Step>

            <Step
              n={4}
              title="Dev buy"
              optional
              subtitle={`Buy up to ${DEV_BUY_MAX_PERCENT_OF_SUPPLY}% of supply in the launch transaction, at the ${BASE_FEE_PERCENT}% fee. You pay for it.`}
            >
              <DevBuyPicker
                percent={devBuyPercent}
                onChange={setDevBuyPercent}
                quote={devBuy}
                quoteSymbol={selectedMode.quoteSymbol}
              />
            </Step>

            <div className="holo-border sticky bottom-3 z-10 flex flex-col gap-4 overflow-hidden rounded-3xl bg-[rgb(26_22_20/0.9)] p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
              <div
                aria-hidden
                className="pointer-events-none absolute -left-16 -top-20 -z-10 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(255,110,20,0.22),transparent_65%)] blur-2xl"
              />
              <dl className="text-sm">
                <div className="flex gap-2">
                  <dt className="text-neutral-400">Pool creation fee</dt>
                  <dd className="font-mono">
                    {availability.loading ? 'Checking…' : `${creationFee} SOL`}
                  </dd>
                </div>
                {devBuyPercent > 0 && (
                  <div className="flex gap-2">
                    <dt className="text-neutral-400">Dev buy</dt>
                    <dd className="font-mono">
                      {devBuy.data
                        ? `${devBuy.data.costQuote.toFixed(4)} ${devBuy.data.quoteSymbol}`
                        : '…'}
                    </dd>
                  </div>
                )}
                <div className="mt-1.5 flex items-baseline gap-2 text-[19px] font-semibold tracking-tight">
                  <dt>Total</dt>
                  <dd className="font-mono">
                    {`≈ ${totalCost.toFixed(4)} SOL`}
                    {price && (
                      <span className="ml-2 text-sm font-normal text-neutral-400">
                        {usd(totalCost)}
                      </span>
                    )}
                  </dd>
                </div>
                <p className="text-xs text-neutral-500">Plus network fees and account rent.</p>
              </dl>
              <Button
                type="submit"
                size="lg"
                variant="holo"
                className="h-12 rounded-2xl px-7 text-[15px]"
                disabled={
                  submitting || (!!publicKey && (!isValid || !availability.data?.canLaunch))
                }
              >
                {submitting ? (
                  <>
                    <span className="iconify h-5 w-5 animate-spin ph--spinner-bold" />
                    Launching…
                  </>
                ) : publicKey ? (
                  <>
                    <span className="iconify h-5 w-5 ph--detective-fill" />
                    Launch masked
                  </>
                ) : (
                  'Connect wallet to launch'
                )}
              </Button>
            </div>
            {availability.notice && (
              <p
                role="status"
                className="flex items-start gap-2 rounded-2xl border border-amber/20 bg-amber/[0.06] p-3.5 text-xs leading-relaxed text-neutral-300"
              >
                {availability.notice}
              </p>
            )}
          </form>

          <aside className="flex flex-col gap-5 lg:sticky lg:top-24 lg:self-start">
            <LaunchPreviewCard
              name={name}
              ticker={ticker}
              image={imagePreview}
              socials={socials}
              mode={selectedMode}
              creatorShareBps={creatorShareBps}
            />
            <ScheduleCard mode={selectedMode} creatorShareBps={creatorShareBps} />
          </aside>
        </div>
      )}
    </Page>
  );
}

function useLaunchAvailability(mode: FeeModeId) {
  const [data, setData] = useState<{
    canLaunch: boolean;
    mode: string;
    configKey?: string;
    poolCreationFeeSol: number;
    policyVersion: string;
    genesis: string;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/launch/status?mode=${mode}`, { signal: controller.signal })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? 'Launch configuration is unavailable');
        if (!Number.isFinite(result.poolCreationFeeSol) || result.poolCreationFeeSol < 0)
          throw new Error('Invalid launch cost');
        setData(result);
        setNotice(result.notice ?? null);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setData(null);
          setNotice(error instanceof Error ? error.message : 'Launch configuration is unavailable');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [mode]);
  return { data: data?.mode === mode ? data : null, notice, loading };
}

const inputClass =
  'well w-full rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-neutral-600 transition-all duration-200 ease-out hover:border-white/[0.12] focus:border-primary/50 focus:outline-none focus:shadow-[inset_0_1px_2px_rgba(0,0,0,0.35),0_0_0_4px_rgba(255,102,0,0.12)]';

const Step = ({
  n,
  title,
  subtitle,
  optional,
  children,
}: React.PropsWithChildren<{
  n: number;
  title: string;
  subtitle?: string;
  optional?: boolean;
}>) => (
  <section className="surface enter rounded-3xl p-5 md:p-6" aria-labelledby={`step-${n}`}>
    <div className="mb-5 flex items-start gap-3.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-b from-[#ff8f45] to-[#f25a00] font-mono text-[13px] font-bold text-[#1a0900] shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_8px_18px_-8px_rgba(255,102,0,0.7)]">
        {n}
      </span>
      <div>
        <h2 id={`step-${n}`} className="text-[18px] font-semibold leading-9 tracking-tight">
          {title}{' '}
          {optional && (
            <span className="chip ml-1 align-middle text-[10px] font-medium text-neutral-400">
              Optional
            </span>
          )}
        </h2>
        {subtitle && <p className="text-[13.5px] leading-relaxed text-neutral-400">{subtitle}</p>}
      </div>
    </div>
    {children}
  </section>
);

const Field = ({
  label,
  htmlFor,
  error,
  hint,
  optional,
  children,
}: React.PropsWithChildren<{
  label: string;
  htmlFor: string;
  error?: string | null;
  hint?: React.ReactNode;
  optional?: boolean;
}>) => (
  <div>
    <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-neutral-300">
      {label} {optional && <span className="text-xs text-neutral-500">(optional)</span>}
    </label>
    {children}
    {error ? (
      <p className="mt-1.5 text-xs text-rose" role="alert">
        {error}
      </p>
    ) : hint ? (
      <p className="mt-1.5 text-xs text-neutral-500">{hint}</p>
    ) : null}
  </div>
);

const ImageDrop = ({ preview, onFile }: { preview: string | null; onFile: (f: File) => void }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const accept = (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) {
      toast.error('Use a PNG, JPG, GIF or WebP image');
    } else if (file.size > LAUNCH_IMAGE_MAX_BYTES) {
      toast.error(`Image must be ${LAUNCH_IMAGE_MAX_MB} MB or smaller`);
    } else {
      onFile(file);
    }
  };

  return (
    <div>
      <p className="mb-1.5 text-sm font-medium text-neutral-300">Image</p>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          accept(e.dataTransfer.files?.[0]);
        }}
        className={cn(
          'group relative flex aspect-square w-full flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed text-center transition-all duration-200 ease-out',
          dragging
            ? 'scale-[1.02] border-primary bg-primary/10 shadow-[0_0_30px_-8px_rgba(255,102,0,0.6)]'
            : 'border-white/[0.12] bg-black/20 hover:border-primary/50 hover:bg-primary/[0.04]'
        )}
      >
        {preview ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={preview}
              alt="Coin image preview"
              className="absolute inset-0 h-full w-full object-cover"
            />
            <span className="glass-strong absolute inset-x-2 bottom-2 translate-y-1 rounded-full py-1.5 text-xs font-semibold text-white opacity-0 transition-all duration-200 ease-out group-hover:translate-y-0 group-hover:opacity-100">
              Change image
            </span>
          </>
        ) : (
          <>
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-white/[0.05] ring-1 ring-inset ring-white/10 transition-transform duration-300 ease-spring group-hover:-translate-y-1 group-hover:scale-110">
              <span className="iconify h-6 w-6 text-neutral-400 transition-colors group-hover:text-primary ph--image-square-bold" />
            </span>
            <span className="mt-3 px-3 text-xs font-medium text-neutral-300">Drop or click</span>
            <span className="text-2xs text-neutral-600">
              PNG, JPG, GIF, WebP · {LAUNCH_IMAGE_MAX_MB} MB
            </span>
          </>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(e) => accept(e.target.files?.[0])}
      />
      <p className="mt-2 text-[11px] text-neutral-500">GIFs use the first frame.</p>
    </div>
  );
};

const DevBuyPicker = ({
  percent,
  onChange,
  quote,
  quoteSymbol,
}: {
  percent: number;
  onChange: (p: number) => void;
  quote: { data: DevBuyQuote | null; loading: boolean };
  quoteSymbol: string;
}) => {
  const { usd, price } = useUsd();
  return (
    <div>
      <div className="flex items-center gap-4">
        <input
          type="range"
          min={0}
          max={DEV_BUY_MAX_PERCENT_OF_SUPPLY}
          step={0.1}
          value={percent}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label="Dev buy, percent of supply"
          className="range-glass flex-1"
          style={
            {
              '--fill': `${(percent / DEV_BUY_MAX_PERCENT_OF_SUPPLY) * 100}%`,
            } as React.CSSProperties
          }
        />
        <div className="relative w-24">
          <input
            type="number"
            min={0}
            max={DEV_BUY_MAX_PERCENT_OF_SUPPLY}
            step={0.1}
            value={percent}
            onChange={(e) =>
              onChange(
                Math.min(Math.max(Number(e.target.value) || 0, 0), DEV_BUY_MAX_PERCENT_OF_SUPPLY)
              )
            }
            aria-label="Dev buy percent"
            className={cn(inputClass, 'pr-7 text-right font-mono')}
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-neutral-500">
            %
          </span>
        </div>
      </div>
      <div className="well mt-4 grid grid-cols-3 gap-3 rounded-2xl p-3.5 text-center">
        <Stat
          label="Tokens"
          value={percent > 0 ? formatReadableNumber((TOTAL_SUPPLY * percent) / 100) : '0'}
        />
        <Stat
          label="You pay"
          value={
            percent === 0
              ? `0 ${quoteSymbol}`
              : quote.data
                ? `${quote.data.costQuote.toFixed(4)} ${quote.data.quoteSymbol}`
                : quote.loading
                  ? '…'
                  : '—'
          }
          sub={
            percent > 0 && quote.data?.quoteSymbol === 'SOL' && price
              ? usd(quote.data.costQuote)
              : undefined
          }
        />
        <Stat
          label="Fee"
          value={
            percent === 0
              ? '—'
              : quote.data
                ? `${quote.data.feeQuote.toFixed(4)} ${quote.data.quoteSymbol}`
                : '…'
          }
        />
      </div>
      <p className="mt-2 text-xs text-neutral-500">
        The app limits this optional first-buy target to {DEV_BUY_MAX_PERCENT_OF_SUPPLY}% of supply.
        This preview does not enforce a total-wallet ownership limit or creator-sale penalty.
      </p>
    </div>
  );
};

const Stat = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
  <div>
    <p className="text-[11px] text-neutral-500">{label}</p>
    <p className="mt-1 font-mono text-[15px] font-semibold tabular-nums">{value}</p>
    {sub && <p className="font-mono text-[11px] text-neutral-500">{sub}</p>}
  </div>
);

function useDevBuyQuote(percent: number, mode: FeeModeId) {
  const [result, setResult] = useState<{
    percent: number;
    mode: FeeModeId;
    data: DevBuyQuote;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (percent <= 0) {
      setResult(null);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    const controller = new AbortController();
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`/api/dev-buy-quote?percent=${percent}&mode=${mode}`, {
          signal: controller.signal,
        });
        const body = await res.json();
        if (!controller.signal.aborted) setResult(res.ok ? { percent, mode, data: body } : null);
      } catch {
        // aborted by a newer input
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(id);
      controller.abort();
    };
  }, [percent, mode]);
  const data =
    result?.mode === mode &&
    result.percent === percent &&
    result.data.quoteSymbol === feeMode(mode).quoteSymbol
      ? result.data
      : null;
  return { data, loading };
}

const ScheduleCard = ({
  mode: launchMode,
  creatorShareBps,
}: {
  mode: FeeMode;
  creatorShareBps: number;
}) => (
  <div className="surface rounded-3xl p-5">
    <p className="eyebrow">Trading fees</p>
    <ol className="mt-3 grid grid-cols-3 gap-1.5 text-center">
      {[
        ['Launch slot', pct(SCHEDULE.startingFeeBps)],
        ['On the curve', pct(SCHEDULE.endingFeeBps)],
        ['After bonding', pct(SCHEDULE.migrationFeeBps)],
      ].map(([label, percent], i) => (
        <li
          key={label}
          className={cn(
            'rounded-2xl px-1 py-2.5 ring-1 ring-inset',
            i === 0
              ? 'bg-rose/10 text-rose ring-rose/20'
              : 'bg-white/[0.04] text-foreground ring-white/[0.07]'
          )}
        >
          <span className="block font-mono text-[16px] font-semibold">{percent}</span>
          <span className="mt-0.5 block text-[10.5px] opacity-80">{label}</span>
        </li>
      ))}
    </ol>
    <FeeSplit mode={launchMode} creatorShareBps={creatorShareBps} compact className="mt-4" />
    <p className="mt-3 text-xs leading-relaxed text-neutral-500">
      The 99% guard lasts one slot, not a seconds countdown. The creator’s bundled first buy pays
      1.25%; later trades by that wallet follow the normal schedule.{' '}
      <Link href="/rules" className="text-primary hover:underline">
        Full rules
      </Link>
    </p>
  </div>
);
