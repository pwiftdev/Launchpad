import { useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { useUnifiedWalletContext, useWallet } from '@jup-ag/wallet-adapter';
import { LaunchPreviewCard } from '@/components/launch/LaunchPreviewCard';
import { Button } from '@/components/ui/button';
import Page from '@/components/ui/Page/Page';
import { formatReadableNumber } from '@/lib/format/number';
import { TOTAL_SUPPLY } from '@/constants/launch';
import { feeMode } from '@/lib/feeModes';
import {
  PREVIEW_TOKEN_PATTERN,
  previewRequest,
  readPreviewInvite,
  unlockPreview,
  type SharedPreview,
} from '@/lib/launchPreview';
import { SocialRequestError } from '@/lib/profiles';
import { adminPageRedirect } from '@/server/adminPage';

export const getServerSideProps: GetServerSideProps = async (context) => {
  const redirect = adminPageRedirect(context);
  context.res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  context.res.setHeader('Referrer-Policy', 'no-referrer');
  return redirect ?? { props: {} };
};

type ViewState =
  | { kind: 'loading' }
  | { kind: 'open'; preview: SharedPreview }
  | { kind: 'locked' | 'invalid' | 'retry'; message: string };

export default function LaunchPreviewPage() {
  const [token, setToken] = useState<string>();
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58();
  useEffect(() => {
    const readInvite = () => setToken(readPreviewInvite());
    readInvite();
    window.addEventListener('hashchange', readInvite);
    return () => window.removeEventListener('hashchange', readInvite);
  }, []);

  return (
    <Page containerClassName="max-w-2xl">
      <Head>
        <title>Private launch preview · MSKD.fun</title>
        <meta name="robots" content="noindex, nofollow, noarchive" />
        <meta name="referrer" content="no-referrer" />
      </Head>
      <header className="mb-5">
        <h1 className="font-term text-xl font-bold uppercase text-primary sm:text-2xl">
          Private launch preview
        </h1>
        <p className="mt-2 text-sm text-neutral-400">Read-only token draft</p>
      </header>
      {token === undefined ? (
        <p role="status">Checking invite…</p>
      ) : PREVIEW_TOKEN_PATTERN.test(token) ? (
        <GuestPreview key={`${token}:${wallet ?? ''}`} token={token} wallet={wallet} />
      ) : (
        <p className="surface p-5 text-sm text-neutral-300">
          Open the full invite link to view this draft.
        </p>
      )}
    </Page>
  );
}

function GuestPreview({ token, wallet }: { token: string; wallet?: string }) {
  const { signMessage } = useWallet();
  const { setShowModal } = useUnifiedWalletContext();
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [signError, setSignError] = useState('');
  const [retry, setRetry] = useState(0);
  const lifetime = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const request = (action: 'check' | 'view') =>
      previewRequest<SharedPreview>({ action, token }, wallet, controller.signal);
    let interval: ReturnType<typeof setInterval> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let checking = false;

    function hide(kind: 'locked' | 'invalid' | 'retry', message: string) {
      if (controller.signal.aborted) return;
      clearInterval(interval);
      clearTimeout(expiry);
      controller.abort();
      setState({ kind, message });
    }

    function report(error: unknown) {
      if (error instanceof SocialRequestError && error.status === 401) {
        hide('locked', error.message);
      } else if (error instanceof SocialRequestError && error.status === 404) {
        hide('invalid', error.message);
      } else {
        hide('retry', 'The preview could not be verified. Try again.');
      }
    }

    async function check() {
      if (checking || controller.signal.aborted) return;
      checking = true;
      try {
        await request('check');
      } catch (error) {
        report(error);
      } finally {
        checking = false;
      }
    }

    void request('view')
      .then((preview) => {
        controller.signal.throwIfAborted();
        if (preview.expiresInMs <= 0) return hide('invalid', 'This invite has expired.');
        setState({ kind: 'open', preview });
        expiry = setTimeout(() => hide('invalid', 'This invite has expired.'), preview.expiresInMs);
        interval = setInterval(() => void check(), 15_000);
        window.addEventListener('focus', check);
      })
      .catch(report);

    return () => {
      controller.abort();
      clearInterval(interval);
      clearTimeout(expiry);
      window.removeEventListener('focus', check);
    };
  }, [token, wallet, retry]);

  function refresh() {
    setState({ kind: 'loading' });
    setRetry((value) => value + 1);
  }

  async function signIn() {
    if (!wallet) return setShowModal(true);
    const signal = lifetime.current?.signal;
    if (!signal || busy) return;
    if (!signMessage) return setSignError('Connect a wallet that can sign messages.');
    setBusy(true);
    setSignError('');
    try {
      await unlockPreview(wallet, signMessage, signal);
      signal.throwIfAborted();
      refresh();
    } catch (error) {
      if (!signal.aborted)
        setSignError(error instanceof Error ? error.message : 'Wallet sign-in failed.');
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }

  if (state.kind === 'loading') return <p role="status">Checking invite…</p>;
  if (state.kind !== 'open')
    return (
      <div className="surface space-y-3 p-5" aria-busy={busy}>
        <p role="status" className="text-sm text-neutral-300">
          {state.message}
        </p>
        {state.kind === 'locked' && (
          <>
            <Button type="button" onClick={() => void signIn()} disabled={busy}>
              {wallet ? 'Sign in with wallet' : 'Connect wallet'}
            </Button>
            {!wallet && (
              <p className="text-xs text-neutral-400 sm:hidden">
                If your wallet opens its own browser, paste the original invite there.
              </p>
            )}
          </>
        )}
        {state.kind === 'retry' && (
          <Button type="button" onClick={refresh}>
            Try again
          </Button>
        )}
        {signError && (
          <p role="alert" className="text-sm text-rose">
            {signError}
          </p>
        )}
      </div>
    );

  const { draft, expiresAt } = state.preview;
  return (
    <div className="space-y-4">
      <LaunchPreviewCard
        name={draft.tokenName}
        ticker={draft.tokenSymbol}
        image={draft.tokenLogo}
        socials={draft.socials}
        source={draft.sourceUrl}
        mode={feeMode(draft.mode)}
      />
      <section className="surface space-y-4 p-5">
        {draft.description && (
          <p className="whitespace-pre-wrap break-words text-sm">{draft.description}</p>
        )}
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-neutral-400">Initial developer buy</dt>
            <dd className="font-mono">
              {draft.devBuyPercent > 0
                ? `${draft.devBuyPercent}% · ${formatReadableNumber((TOTAL_SUPPLY * draft.devBuyPercent) / 100)} tokens`
                : 'None'}
            </dd>
          </div>
          <div>
            <dt className="text-neutral-400">Invite expires</dt>
            <dd>
              <time dateTime={expiresAt}>{new Date(expiresAt).toLocaleString()}</time>
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
