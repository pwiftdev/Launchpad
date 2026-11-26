import { useEffect, useState } from 'react';
import { useUnifiedWalletContext, useWallet } from '@jup-ag/wallet-adapter';
import { Button } from '@/components/ui/button';
import { otcAcceptanceMessage, otcRequest, unlockOtc, type ViewedOtcOffer } from '@/lib/otc';
import { messageSignature, SocialRequestError } from '@/lib/profiles';
import { cn } from '@/lib/utils';
import { OtcExpiryTime, OtcFeedback, OtcIcon, OtcPanelHead, otcFeature } from './OtcLayout';
import { OtcTermsCard } from './OtcTermsCard';
import { useOtcAction } from './useOtcAction';

type ViewState =
  | { kind: 'loading' }
  | { kind: 'open'; offer: ViewedOtcOffer }
  | { kind: 'locked' | 'invalid' | 'retry'; message: string };

export function OtcOfferReview({
  token,
  wallet,
  onDeal,
  onBack,
}: {
  token: string;
  wallet?: string;
  onDeal?: (id: string) => void;
  onBack: () => void;
}) {
  const { signMessage } = useWallet();
  const { setShowModal } = useUnifiedWalletContext();
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [reload, setReload] = useState(0);
  const { busy, error, run } = useOtcAction();

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    async function load() {
      if (signal.aborted || busy) return;
      busy = true;
      clearTimeout(timer);
      try {
        const started = performance.now();
        const offer = await otcRequest<ViewedOtcOffer>({ action: 'view', token }, wallet, signal);
        signal.throwIfAborted();
        const remaining = offer.expiresInMs - (performance.now() - started);
        if (remaining <= 0) {
          setState({ kind: 'invalid', message: 'This offer has expired.' });
          return;
        }
        setState({ kind: 'open', offer });
        timer = setTimeout(
          () => {
            if (remaining <= 15_000)
              setState({ kind: 'invalid', message: 'This offer has expired.' });
            else void load();
          },
          Math.min(remaining, 15_000)
        );
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof SocialRequestError && error.status === 401) {
          setState({ kind: 'locked', message: error.message });
        } else if (error instanceof SocialRequestError && error.status === 404) {
          setState({ kind: 'invalid', message: error.message });
        } else {
          setState({ kind: 'retry', message: 'The offer could not be verified. Try again.' });
        }
      } finally {
        busy = false;
      }
    }
    void load();
    window.addEventListener('focus', load);
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener('focus', load);
    };
  }, [token, wallet, reload]);

  function refresh() {
    setState({ kind: 'loading' });
    setReload((value) => value + 1);
  }

  function unlock() {
    if (!wallet) return setShowModal(true);
    void run(async (signal) => {
      if (!signMessage) throw new Error('Connect a wallet that supports signing messages.');
      await unlockOtc(wallet, signMessage, signal);
      signal.throwIfAborted();
      refresh();
    });
  }

  function accept(offer: ViewedOtcOffer) {
    if (!wallet || !offer.canAccept) return;
    void run(async (signal) => {
      if (!signMessage) throw new Error('Connect a wallet that supports signing messages.');
      const message = await otcAcceptanceMessage(
        token,
        wallet,
        window.location.origin,
        offer.genesis,
        offer
      );
      signal.throwIfAborted();
      const signature = messageSignature(await signMessage(new TextEncoder().encode(message)));
      signal.throwIfAborted();
      try {
        await otcRequest({ action: 'accept', token, signature }, wallet, signal);
      } catch (error) {
        signal.throwIfAborted();
        const latest = await otcRequest<ViewedOtcOffer>(
          { action: 'view', token },
          wallet,
          signal
        ).catch((): null => null);
        if (latest?.status !== 'accepted') throw error;
      } finally {
        if (!signal.aborted) refresh();
      }
    });
  }

  return (
    <section className={cn(otcFeature, 'space-y-6 p-5 sm:p-8')} aria-busy={busy}>
      <Button type="button" variant="ghost" size="sm" className="-ml-3 -mt-2" onClick={onBack}>
        <OtcIcon name="ph--arrow-left" className="h-4 w-4" /> Back to desk
      </Button>
      <OtcPanelHead
        eyebrow="You’ve been sent an offer"
        title="Review the terms"
        icon="ph--envelope-open"
      >
        Check exactly what you’d send and receive. Nothing happens until you sign, and signing moves
        no funds.
      </OtcPanelHead>
      {state.kind === 'loading' ? (
        <p role="status" className="eyebrow">
          Checking offer…
        </p>
      ) : state.kind === 'open' ? (
        <>
          <OtcTermsCard terms={state.offer.terms} guest />
          <p className="-mt-3 flex items-center gap-2 font-term text-[10px] uppercase tracking-[0.12em] text-neutral-500">
            <OtcIcon name="ph--clock" className="h-3.5 w-3.5" /> Offer deadline{' '}
            <span className="text-neutral-300">
              <OtcExpiryTime date={state.offer.expiresAt} />
            </span>
          </p>
          {state.offer.status === 'open' ? (
            <div className="space-y-3 border-t border-neutral-850 pt-5">
              <Button
                type="button"
                size="lg"
                variant="holo"
                onClick={() => (state.offer.canAccept ? accept(state.offer) : unlock())}
                disabled={busy}
              >
                {busy
                  ? 'Waiting for wallet…'
                  : state.offer.canAccept
                    ? 'Sign agreement'
                    : wallet
                      ? 'Sign in to agree'
                      : 'Connect to agree'}
              </Button>
              <p className="text-xs leading-relaxed text-neutral-500">
                Your signature records the agreement off-chain. It’s a message, not a transaction.
                {onDeal ? ' Funding is a separate step.' : ''}
              </p>
            </div>
          ) : (
            <p
              role="status"
              className={cn(
                'flex items-center gap-2.5 border px-4 py-3 text-sm',
                state.offer.status === 'accepted'
                  ? 'border-emerald/30 bg-emerald/[0.05] text-neutral-100'
                  : 'border-neutral-800 bg-neutral-950 text-neutral-300'
              )}
            >
              <OtcIcon
                name={state.offer.status === 'accepted' ? 'ph--check-circle' : 'ph--info'}
                className={cn(
                  'h-4 w-4',
                  state.offer.status === 'accepted' ? 'text-emerald' : 'text-neutral-400'
                )}
              />
              {state.offer.status === 'accepted'
                ? onDeal
                  ? 'Agreement recorded. Open the deal to see the funding steps.'
                  : 'Agreement recorded off-chain. No funds have moved.'
                : state.offer.status === 'reserved'
                  ? 'This offer already has a counterparty.'
                  : 'You created this offer.'}
            </p>
          )}
          {state.offer.dealId && onDeal && (
            <Button
              type="button"
              size="lg"
              variant="holo"
              onClick={() => onDeal(state.offer.dealId!)}
            >
              Open deal <OtcIcon name="ph--arrow-right" className="h-4 w-4" />
            </Button>
          )}
        </>
      ) : (
        <>
          <p
            role="status"
            className="flex items-start gap-2.5 border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm text-neutral-300"
          >
            <OtcIcon
              name={state.kind === 'locked' ? 'ph--lock-simple' : 'ph--warning-circle'}
              className="mt-px h-4 w-4 text-neutral-400"
            />
            {state.message}
          </p>
          {state.kind === 'locked' && (
            <>
              <Button type="button" size="lg" variant="holo" onClick={unlock} disabled={busy}>
                {wallet ? 'Sign in to review' : 'Connect invited wallet'}
              </Button>
              {!wallet && (
                <p className="text-xs text-neutral-400 sm:hidden">
                  If your wallet opens a new browser, paste the original offer link there.
                </p>
              )}
            </>
          )}
          {state.kind === 'retry' && (
            <Button type="button" onClick={refresh}>
              Try again
            </Button>
          )}
        </>
      )}
      <OtcFeedback error={error} />
    </section>
  );
}
