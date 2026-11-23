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
import { CoinAvatar } from '@/components/coin/CoinAvatar';
import { BondingBar } from '@/components/coin/BondingBar';
import { BRAND } from '@/constants/brand';
import { BASE_FEE_PERCENT, DEV_BUY_MAX_PERCENT_OF_SUPPLY, TOTAL_SUPPLY } from '@/constants/launch';
import { normalizeTicker } from '@/lib/antivamp/normalizeTicker';
import { useUsd } from '@/hooks/useUsd';
import { getDemoCoin } from '@/lib/demo';
import { ACTIVE_LAUNCH_MODE } from '@/lib/launchModes';
import { DEFAULT_FEE_MODE, SCHEDULE, SPLIT, feeMode, pct, type FeeMode, type FeeModeId } from '@/lib/feeModes';
import { ModePicker } from '@/components/launch/ModePicker';
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
  SOCIAL_MAX_LENGTH,
  hasSocials,
  type SocialKind,
} from '@/lib/socials';
import { SOCIAL_ICONS, SocialLinks } from '@/components/coin/SocialLinks';
export { requireAdminPage as getServerSideProps } from '@/server/adminPage';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const TWEET_URL = /^https:\/\/(x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+\/?(\?.*)?$/;


type DevBuyQuote = { tokens: number; costQuote: number; feeQuote: number; quoteSymbol: string };

const EMPTY_LINKS: Record<SocialKind, string> = {
  website: '',
  twitter: '',
  telegram: '',
  discord: '',
};
const LINK_PLACEHOLDERS: Record<SocialKind, string> = {
  website: 'maskedfrog.xyz',
  twitter: '@maskedfrog or x.com/i/communities/…',
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
  const [tweetUrl, setTweetUrl] = useState('');
  const [links, setLinks] = useState(EMPTY_LINKS);
  const [feeModeId, setFeeModeId] = useState<FeeModeId>(DEFAULT_FEE_MODE);
  const mode = feeModeId;
  const selectedMode = feeMode(feeModeId);
  const availability = useLaunchAvailability(feeModeId);
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

  function resetLaunch() {
    setLaunched(null);
    setName('');
    setTicker('');
    setDescription('');
    setImage(null);
    setTweetUrl('');
    setLinks(EMPTY_LINKS);
    setDevBuyPercent(0);
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

  const normalized = useMemo(() => normalizeTicker(ticker), [ticker]);
  const check = useLaunchCheck(name.trim(), ticker.trim(), tweetUrl);
  // Rejection returned by the server on submit (e.g. a copied image), cleared on any edit
  const [serverError, setServerError] = useState<{ field: string; error: string } | null>(null);
  useEffect(() => setServerError(null), [name, ticker, tweetUrl, image]);
  const ruleError = (field: string) =>
    (serverError?.field === field && serverError.error) ||
    (check.status === 'rejected' && check.field === field ? check.error : null);

  const errors = {
    name:
      name.trim().length === 0
        ? 'Give your coin a name'
        : name.length > 32
          ? 'Max 32 characters'
          : ruleError('name'),
    ticker:
      normalized.length === 0
        ? 'Add a ticker'
        : ticker.length > 10
          ? 'Max 10 characters'
          : ruleError('ticker'),
    image: image ? ruleError('image') : 'Add an image',
    tweet:
      tweetUrl && !TWEET_URL.test(tweetUrl)
        ? 'Paste a link to a single post on X'
        : ruleError('source'),
  };
  const linkErrors = Object.fromEntries(
    SOCIAL_KINDS.map((kind) => [
      kind,
      links[kind].trim() && !normalizeSocial(kind, links[kind])
        ? kind === 'website'
          ? 'Enter a website address'
          : kind === 'twitter'
            ? 'Use an X handle, profile or community link'
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
      const tokenLogo = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target?.result as string);
        reader.onerror = () => reject(new Error('Could not read the image'));
        reader.readAsDataURL(image);
      });
      const mintKeypair = Keypair.generate();
      const payload: LaunchPayload = {
        tokenLogo,
        mint: mintKeypair.publicKey.toBase58(),
        tokenName: name.trim(),
        tokenSymbol: ticker.trim().replace(/^\$+/, '').toUpperCase(),
        userWallet: publicKey.toBase58(),
        devBuyPercent,
        sourceUrl: tweetUrl || undefined,
        description: description.trim() || undefined,
        socials: hasSocials(socials) ? socials : undefined,
        burnShare: 0,
        configKey: availability.data.configKey,
        mode,
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
      if (uploadResponse.status === 422) {
        setServerError({ field: upload.field, error: upload.error });
        throw new Error(upload.error);
      }
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
          <h1 className="mt-4 font-display text-[30px] uppercase leading-[1.05] md:text-[46px]">
            <Decrypt text="Your keys." />
            <br />
            <Decrypt text="Your launch." delay={160} className="text-holo" />
          </h1>
          <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-neutral-400">
            {NETWORK === 'mainnet-beta'
              ? 'Create a coin on Solana Mainnet. Transactions use real SOL.'
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
                  <Field
                    label="Ticker"
                    htmlFor="ticker"
                    error={ticker ? errors.ticker : null}
                    hint={
                      !normalized ? (
                        'Lookalikes like P3PE or Cyrillic letters count as the same ticker.'
                      ) : check.status === 'checking' ? (
                        <>
                          Checking <span className="font-mono text-neutral-200">{normalized}</span>…
                        </>
                      ) : check.status === 'ok' ? (
                        <span className="text-emerald">
                          <span className="iconify mr-1 h-3 w-3 align-[-2px] ph--check-bold" />
                          <span className="font-mono">${normalized}</span> is free to launch
                        </span>
                      ) : (
                        <>
                          Duplicate check runs on{' '}
                          <span className="font-mono text-neutral-200">{normalized}</span>
                        </>
                      )
                    }
                  >
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
                  <Field
                    label="Source post on X"
                    optional
                    htmlFor="tweet"
                    error={errors.tweet}
                    hint="Each post can be used for one launch only."
                  >
                    <input
                      id="tweet"
                      type="url"
                      inputMode="url"
                      className={inputClass}
                      placeholder="https://x.com/user/status/123…"
                      value={tweetUrl}
                      onChange={(e) => setTweetUrl(e.target.value.trim())}
                    />
                  </Field>
                </div>
                <ImageDrop
                  preview={imagePreview}
                  onFile={setImage}
                  error={image ? errors.image : null}
                />
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
                        maxLength={SOCIAL_MAX_LENGTH}
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
              title="Mode"
              subtitle={`${pct(SCHEDULE.endingFeeBps)} flat, before and after bonding. The mode decides who gets the ${pct(SPLIT.beneficiaryBps)}.`}
            >
              <ModePicker value={feeModeId} onChange={setFeeModeId} />
              <FeeSplit mode={selectedMode} className="mt-4" />
              <p className="mt-3 text-xs leading-relaxed text-neutral-500">
                {selectedMode.beneficiary === 'holders'
                  ? `Holder payouts are batched from collected fees and paid in ${selectedMode.payoutSymbol}, pro rata to balances. Pools, burn and house wallets are excluded.`
                  : 'Creator payouts follow collected fees. The creator requests them by signing a message; no transaction is needed.'}{' '}
                Bonding is not guaranteed.
              </p>
            </Step>

            <Step
              n={4}
              title="Dev buy"
              optional
              subtitle={`Buy up to ${DEV_BUY_MAX_PERCENT_OF_SUPPLY}% of supply in the launch transaction, at the ${BASE_FEE_PERCENT}% fee. You pay for it.`}
            >
              <DevBuyPicker percent={devBuyPercent} onChange={setDevBuyPercent} quote={devBuy} />
            </Step>

            <div className="holo-border flex flex-col gap-4 rounded-2xl bg-panel p-5 sm:flex-row sm:items-center sm:justify-between">
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
                      {devBuy.data ? `${devBuy.data.costQuote.toFixed(4)} ${devBuy.data.quoteSymbol}` : '…'}
                    </dd>
                  </div>
                )}
                <div className="mt-1 flex gap-2 text-base font-bold">
                  <dt>Total</dt>
                  <dd className="font-mono">
                    ≈ {totalCost.toFixed(4)} SOL
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
                className="rounded-xl border border-amber/20 bg-amber/5 p-3 text-xs leading-relaxed text-neutral-400"
              >
                {availability.notice}
              </p>
            )}
          </form>

          <aside className="flex flex-col gap-5 lg:sticky lg:top-24 lg:self-start">
            <PreviewCard
              name={name}
              ticker={ticker}
              image={imagePreview}
              socials={socials}
              mode={selectedMode}
            />
            <ScheduleCard mode={selectedMode} />
          </aside>
        </div>
      )}
    </Page>
  );
}

function useLaunchAvailability(mode: FeeModeId | typeof ACTIVE_LAUNCH_MODE) {
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
  'w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3.5 py-2.5 text-sm text-foreground placeholder:text-neutral-600 transition-colors focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/30';

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
  <section className="surface p-5 md:p-6" aria-labelledby={`step-${n}`}>
    <div className="mb-4 flex items-start gap-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-neutral-700 bg-neutral-950 font-term text-xs font-bold text-acid">
        {n}
      </span>
      <div>
        <h2
          id={`step-${n}`}
          className="font-display text-[15px] font-bold leading-8 tracking-tight"
        >
          {title}{' '}
          {optional && <span className="text-xs font-normal text-neutral-500">(optional)</span>}
        </h2>
        {subtitle && <p className="text-sm text-neutral-400">{subtitle}</p>}
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

const ImageDrop = ({
  preview,
  onFile,
  error,
}: {
  preview: string | null;
  onFile: (f: File) => void;
  /** Rejection from the server, e.g. a copied image */
  error?: string | null;
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const accept = (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) {
      toast.error('Use a PNG, JPG, GIF or WebP image');
    } else if (file.size > MAX_IMAGE_BYTES) {
      toast.error('Image must be 2 MB or smaller');
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
          'group relative flex aspect-square w-full flex-col items-center justify-center overflow-hidden rounded-xl border-2 border-dashed text-center transition-colors',
          dragging
            ? 'border-primary bg-primary/10'
            : 'border-neutral-800 bg-neutral-950 hover:border-primary/50'
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
            <span className="absolute inset-x-2 bottom-2 rounded-full bg-ink/80 py-1 text-xs font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100">
              Change image
            </span>
          </>
        ) : (
          <>
            <span className="iconify h-8 w-8 text-neutral-500 ph--image-square-bold" />
            <span className="mt-2 px-3 text-xs text-neutral-400">Drop or click</span>
            <span className="text-2xs text-neutral-600">PNG, JPG, GIF, WebP · 2 MB</span>
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
      {error ? (
        <p className="mt-1.5 text-xs text-rose" role="alert">
          {error}
        </p>
      ) : (
        <p className="mt-1.5 text-2xs text-neutral-500">
          Copies of existing coin images are refused.
        </p>
      )}
    </div>
  );
};

const DevBuyPicker = ({
  percent,
  onChange,
  quote,
}: {
  percent: number;
  onChange: (p: number) => void;
  quote: { data: DevBuyQuote | null; loading: boolean };
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
          className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-neutral-850 accent-primary"
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
      <div className="mt-3 grid grid-cols-3 gap-3 rounded-xl bg-neutral-950 p-3 text-center">
        <Stat
          label="Tokens"
          value={percent > 0 ? formatReadableNumber((TOTAL_SUPPLY * percent) / 100) : '0'}
        />
        <Stat
          label="You pay"
          value={
            percent === 0
              ? '0 SOL'
              : quote.data
                ? `${quote.data.costQuote.toFixed(4)} ${quote.data.quoteSymbol}`
                : quote.loading
                  ? '…'
                  : '—'
          }
          sub={percent > 0 && quote.data?.quoteSymbol === 'SOL' && price ? usd(quote.data.costQuote) : undefined}
        />
        <Stat
          label="Fee"
          value={percent === 0 ? '—' : quote.data ? `${quote.data.feeQuote.toFixed(4)} ${quote.data.quoteSymbol}` : '…'}
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
    <p className="text-2xs uppercase tracking-wider text-neutral-500">{label}</p>
    <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums">{value}</p>
    {sub && <p className="font-mono text-[11px] text-neutral-500">{sub}</p>}
  </div>
);

type LaunchCheck =
  { status: 'idle' | 'checking' | 'ok' } | { status: 'rejected'; field: string; error: string };

/** Live anti-vamp pre-check (ticker, name copies, source post) while the creator types. */
function useLaunchCheck(name: string, symbol: string, sourceUrl: string): LaunchCheck {
  const [state, setState] = useState<LaunchCheck>({ status: 'idle' });
  useEffect(() => {
    if (!normalizeTicker(symbol)) {
      setState({ status: 'idle' });
      return undefined;
    }
    setState({ status: 'checking' });
    const controller = new AbortController();
    const id = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ name, symbol, sourceUrl });
        const res = await fetch(`/api/launch-check?${params}`, { signal: controller.signal });
        const body = await res.json();
        if (!res.ok) setState({ status: 'idle' });
        else if (body.ok) setState({ status: 'ok' });
        else setState({ status: 'rejected', field: body.field, error: body.error });
      } catch {
        // superseded by newer input
      }
    }, 450);
    return () => {
      clearTimeout(id);
      controller.abort();
    };
  }, [name, symbol, sourceUrl]);
  return state;
}

function useDevBuyQuote(percent: number, mode: FeeModeId) {
  const [data, setData] = useState<DevBuyQuote | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (percent <= 0) {
      setData(null);
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
        if (!controller.signal.aborted) setData(res.ok ? body : null);
      } catch {
        // aborted by a newer input
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(id);
      controller.abort();
    };
  }, [percent, mode]);
  return { data: data?.quoteSymbol === 'SOL' ? data : null, loading };
}

const PreviewCard = ({
  name,
  ticker,
  image,
  socials,
  mode: launchMode,
}: {
  name: string;
  ticker: string;
  image: string | null;
  socials: ReturnType<typeof normalizeSocials>;
  mode: FeeMode;
}) => (
  <div className="surface p-5">
    <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
      Preview on the board
    </p>
    <div className="mt-3 flex gap-3 rounded-xl border border-neutral-850 bg-neutral-950 p-3">
      <CoinAvatar image={image} symbol={ticker || 'P'} className="h-16 w-16 text-2xl" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-bold">{name || 'Your coin'}</p>
        <p className="truncate font-mono text-xs text-neutral-500">
          ${(ticker || 'TICKER').toUpperCase()}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full bg-rose/15 px-2 py-0.5 font-mono text-2xs font-bold text-rose">
            <span className="iconify h-3 w-3 ph--crosshair-fill" />
            Launch slot {pct(SCHEDULE.startingFeeBps)}
          </span>
          <span className="border border-neutral-700 px-2 py-0.5 font-term text-2xs font-semibold uppercase tracking-wide text-neutral-300">
            {launchMode.label}
          </span>
        </div>
        <BondingBar progress={0} className="mt-2 h-1.5" />
      </div>
    </div>
    <SocialLinks socials={socials} className="mt-2 -ml-1.5" />
  </div>
);

const ScheduleCard = ({ mode: launchMode }: { mode: FeeMode }) => (
  <div className="surface p-5">
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
            'rounded-lg px-1 py-2',
            i === 0 ? 'bg-rose/10 text-rose' : 'bg-neutral-900 text-foreground'
          )}
        >
          <span className="block font-mono text-sm font-bold">{percent}</span>
          <span className="block text-2xs opacity-80">{label}</span>
        </li>
      ))}
    </ol>
    <FeeSplit mode={launchMode} compact className="mt-4" />
    <p className="mt-3 text-xs leading-relaxed text-neutral-500">
      The 99% guard lasts one slot, not a seconds countdown. The creator’s bundled first buy pays
      1.25%; later trades by that wallet follow the normal schedule.{' '}
      <Link href="/rules" className="text-primary hover:underline">
        Full rules
      </Link>
    </p>
  </div>
);
