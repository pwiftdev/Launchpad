import { useEffect, useState } from 'react';
import { useUnifiedWalletContext, useWallet } from '@jup-ag/wallet-adapter';
import { Button } from '@/components/ui/button';
import { OTC_PATH } from '@/constants/nav';
import {
  OTC_EXPIRIES,
  OTC_FEE_RESERVE,
  otcRequest,
  unlockOtc,
  type OwnedOtcOffer,
} from '@/lib/otc';
import { ringsRequest, type RingsRoomLink } from '@/lib/otcRingsRoom';
import { SocialRequestError } from '@/lib/profiles';
import { cn } from '@/lib/utils';
import type { OtcFlowStep } from './OtcHero';
import {
  OtcExpiryTime,
  OtcFeedback,
  OtcGrid,
  OtcIcon,
  OtcPanelHead,
  OtcPrivacy,
  otcFeature,
  otcPanel,
} from './OtcLayout';
import { OtcOfferForm, type OtcOfferDraft } from './OtcOfferForm';
import { OtcAssetMark, OtcTermsCard } from './OtcTermsCard';
import { useOtcAction } from './useOtcAction';

const views = { create: 'New offer', offers: 'My offers', deals: 'My deals' } as const;
type DeskView = keyof typeof views;

export function OtcDesk({
  wallet,
  onDeal,
  settlementEnabled,
  onStep,
}: {
  wallet?: string;
  onDeal?: (id: string) => void;
  settlementEnabled?: boolean;
  /** Reports where the creator is in the trade, for the flow rail above the desk. */
  onStep?: (step: OtcFlowStep) => void;
}) {
  const { signMessage } = useWallet();
  const { setShowModal } = useUnifiedWalletContext();
  const [offers, setOffers] = useState<OwnedOtcOffer[] | null>(null);
  const [deals, setDeals] = useState<RingsRoomLink[]>([]);
  const [view, setView] = useState<DeskView>('create');
  const [invitation, setInvitation] = useState<{ id: string; url: string } | null>(null);
  const [notice, setNotice] = useState('');
  const { busy, error, run } = useOtcAction((error) => {
    if (error instanceof SocialRequestError && error.status === 401) {
      setOffers(null);
      setDeals([]);
      setInvitation(null);
    }
  });
  const invitationId = invitation?.id;
  const invitedOffer = offers?.find(({ id }) => id === invitationId);
  const waitingForAgreement = invitedOffer?.accepted === false;
  const step: OtcFlowStep = !invitation
    ? 'create'
    : invitedOffer?.accepted
      ? settlementEnabled
        ? 'fund'
        : 'agree'
      : 'share';
  useEffect(() => onStep?.(step), [onStep, step]);

  useEffect(() => {
    if (!invitationId || !wallet || !waitingForAgreement || busy || view !== 'create') return;
    const controller = new AbortController();
    let checking = false;
    async function check() {
      if (checking || controller.signal.aborted || document.visibilityState === 'hidden') return;
      checking = true;
      try {
        const { offers: latest } = await otcRequest<{ offers: OwnedOtcOffer[] }>(
          { action: 'list' },
          wallet,
          AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)])
        );
        controller.signal.throwIfAborted();
        const update = latest.find(({ id }) => id === invitationId);
        if (!update || update.accepted)
          setOffers(
            (current) =>
              current?.flatMap((offer) =>
                offer.id !== invitationId ? [offer] : update ? [update] : []
              ) ?? null
          );
      } catch {
        // The same offer remains available through My offers and its manual refresh.
      } finally {
        checking = false;
      }
    }
    const interval = window.setInterval(check, 12_000);
    window.addEventListener('focus', check);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener('focus', check);
    };
  }, [invitationId, wallet, waitingForAgreement, busy, view]);

  async function load(signal: AbortSignal) {
    const result = await otcRequest<{ offers: OwnedOtcOffer[] }>(
      { action: 'list' },
      wallet,
      signal
    );
    signal.throwIfAborted();
    setOffers(result.offers);
    if (wallet && onDeal) {
      const rooms = await ringsRequest<RingsRoomLink[]>({ action: 'list' }, wallet, signal);
      signal.throwIfAborted();
      setDeals(rooms);
    }
  }

  function openDesk() {
    if (!wallet) return setShowModal(true);
    void run(async (signal) => {
      try {
        await load(signal);
      } catch (error) {
        if (!(error instanceof SocialRequestError) || error.status !== 401) throw error;
        if (!signMessage) throw new Error('Connect a wallet that supports signing messages.');
        await unlockOtc(wallet, signMessage, signal);
        await load(signal);
      }
    });
  }

  function createOffer(draft: OtcOfferDraft) {
    if (!wallet || !offers) return;
    setNotice('');
    void run(async (signal) => {
      const { offer, token } = await otcRequest<{ offer: OwnedOtcOffer; token: string }>(
        { action: 'create', ...draft },
        wallet,
        signal
      );
      signal.throwIfAborted();
      setOffers((current) => [offer, ...(current ?? [])]);
      setInvitation({ id: offer.id, url: `${window.location.origin}${OTC_PATH}#${token}` });
    });
  }

  function revoke(id: string) {
    setNotice('');
    void run(async (signal) => {
      await otcRequest({ action: 'revoke', id }, wallet, signal);
      signal.throwIfAborted();
      setOffers((current) => current?.filter((offer) => offer.id !== id) ?? null);
      setInvitation((link) => (link?.id === id ? null : link));
      setNotice('Offer revoked.');
    });
  }

  async function copyLink() {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitation.url);
      setNotice('Link copied.');
    } catch {
      setNotice('Select and copy the offer link.');
    }
  }

  const tabs: DeskView[] = onDeal ? ['create', 'offers', 'deals'] : ['create', 'offers'];
  const counts: Partial<Record<DeskView, number>> = { offers: offers?.length, deals: deals.length };
  const roomIds = new Set(deals.map(({ id }) => id));
  return (
    <OtcGrid
      aside={
        <>
          <OtcPrivacy settlement={!!onDeal} />
          <DeskSpecs settlement={!!settlementEnabled} />
        </>
      }
    >
      {!offers ? (
        <section className={cn(otcFeature, 'overflow-hidden')} aria-busy={busy}>
          <div className="grid gap-8 p-5 sm:p-8 md:grid-cols-[minmax(0,1fr)_minmax(0,19rem)] md:items-center">
            <div className="space-y-6">
              <OtcPanelHead
                eyebrow={wallet ? 'Wallet connected' : 'Desk locked'}
                title="Open your desk"
              >
                {wallet
                  ? 'Sign a message to unlock your desk. It proves you own this wallet and moves no funds.'
                  : 'Connect a wallet to create offers, track agreements and pick up deals you’ve already started.'}
              </OtcPanelHead>
              <OtcFeedback error={error} />
              <div className="space-y-3">
                <Button type="button" size="lg" variant="holo" disabled={busy} onClick={openDesk}>
                  <OtcIcon name={wallet ? 'ph--lock-key-open' : 'ph--wallet'} className="h-4 w-4" />
                  {busy ? 'Opening desk…' : wallet ? 'Unlock desk' : 'Connect wallet'}
                </Button>
                <p className="font-term text-[10px] uppercase tracking-[0.12em] text-neutral-500">
                  {wallet
                    ? 'Message signature · no transaction · no fee'
                    : 'No account · no email · no KYC'}
                </p>
              </div>
            </div>
            <SampleTicket />
          </div>
        </section>
      ) : (
        <>
          <nav
            aria-label="OTC desk"
            className="grid auto-cols-fr grid-flow-col border border-neutral-800 bg-neutral-950"
          >
            {tabs.map((tab) => (
              <button
                type="button"
                key={tab}
                aria-pressed={tab === view}
                disabled={busy}
                className={cn(
                  'relative flex min-h-11 items-center justify-center gap-2 border-l border-neutral-800 px-3 font-term text-[11px] uppercase tracking-[0.12em] transition-colors first:border-l-0 disabled:opacity-60',
                  tab === view
                    ? 'bg-panel text-foreground'
                    : 'text-neutral-500 hover:bg-neutral-900 hover:text-foreground'
                )}
                onClick={() => {
                  if (tab === view) return;
                  setView(tab);
                  setNotice('');
                  if (tab !== 'create') void run(load);
                }}
              >
                {tab === view && (
                  <span aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-primary" />
                )}
                <OtcIcon
                  name={
                    tab === 'create' ? 'ph--plus' : tab === 'offers' ? 'ph--link' : 'ph--handshake'
                  }
                  className={cn('h-3.5 w-3.5', tab === view ? 'text-primary' : '')}
                />
                {views[tab]}
                {counts[tab] ? (
                  <span className="min-w-5 border border-neutral-700 px-1 text-center text-[10px] text-neutral-300">
                    {counts[tab]}
                  </span>
                ) : null}
              </button>
            ))}
          </nav>
          {view === 'create' ? (
            <OtcOfferForm
              busy={busy}
              onCreate={createOffer}
              invitation={invitation?.url}
              tokenWallet={settlementEnabled ? wallet : undefined}
              agreement={
                invitedOffer ? (invitedOffer.accepted ? 'accepted' : 'waiting') : 'unavailable'
              }
              onOpenDeal={
                invitedOffer?.accepted && onDeal && settlementEnabled
                  ? () => onDeal(invitedOffer.id)
                  : undefined
              }
              onCopy={() => void copyLink()}
              onNew={() => {
                setInvitation(null);
                setNotice('');
              }}
              error={error}
              notice={notice}
            />
          ) : (
            <section
              className={cn(otcPanel, 'space-y-5 p-5 sm:p-6')}
              aria-label={views[view]}
              aria-busy={busy}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <OtcPanelHead
                  title={views[view]}
                  eyebrow={view === 'offers' ? 'Links you created' : 'Settlement rooms'}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(load)}
                >
                  <OtcIcon
                    name="ph--arrows-clockwise"
                    className={cn('h-4 w-4', busy && 'animate-spin')}
                  />{' '}
                  Refresh
                </Button>
              </div>
              <OtcFeedback error={error} notice={notice} />
              {view === 'offers' ? (
                offers.length ? (
                  <ul className="space-y-3">
                    {offers.map((offer) => {
                      const hasRoom = roomIds.has(offer.id);
                      return (
                        <li key={offer.id} className="border border-neutral-850 bg-neutral-950/50">
                          <div className="p-3 sm:p-4">
                            <OtcTermsCard terms={offer.terms} />
                          </div>
                          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-850 px-3 py-3 sm:px-4">
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-neutral-400">
                              <StatusTag
                                tone={offer.accepted ? 'done' : 'waiting'}
                                label={offer.accepted ? 'Agreed' : 'Awaiting agreement'}
                              />
                              <span className="flex items-center gap-1">
                                <OtcIcon
                                  name={offer.viewerWallet ? 'ph--user-focus' : 'ph--link'}
                                  className="h-3.5 w-3.5"
                                />
                                {offer.viewerWallet
                                  ? 'Invited wallet only'
                                  : 'Anyone with the link'}
                              </span>
                              <span className="flex items-center gap-1">
                                <OtcIcon name="ph--clock" className="h-3.5 w-3.5" />
                                <OtcExpiryTime date={offer.expiresAt} />
                              </span>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {(hasRoom || (settlementEnabled && offer.accepted)) && onDeal && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="holo"
                                  disabled={busy}
                                  onClick={() => onDeal(offer.id)}
                                >
                                  Open deal{' '}
                                  <OtcIcon name="ph--arrow-right" className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {!hasRoom && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  disabled={busy}
                                  onClick={() => revoke(offer.id)}
                                >
                                  Revoke
                                </Button>
                              )}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <EmptyDesk
                    icon="ph--link"
                    title="No open offers"
                    text="Offers you create appear here until they expire or you revoke them."
                    action={() => setView('create')}
                  />
                )
              ) : deals.length && onDeal ? (
                <ul className="space-y-3">
                  {deals.map((deal) => (
                    <li key={deal.id} className="border border-neutral-850 bg-neutral-950/50">
                      <div className="p-3 sm:p-4">
                        <OtcTermsCard terms={deal.terms} guest={deal.side === 'taker'} />
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-850 px-3 py-3 sm:px-4">
                        <p className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-neutral-400">
                          <StatusTag
                            tone="waiting"
                            label={deal.side === 'taker' ? 'You accepted' : 'You offered'}
                          />
                          <span className="flex items-center gap-1">
                            <OtcIcon name="ph--clock" className="h-3.5 w-3.5" />
                            Deadline <OtcExpiryTime date={deal.expiresAt} />
                          </span>
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          variant="holo"
                          disabled={busy}
                          onClick={() => onDeal(deal.id)}
                        >
                          Resume deal <OtcIcon name="ph--arrow-right" className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyDesk
                  icon="ph--handshake"
                  title="No deals yet"
                  text="A deal appears here once either wallet opens the settlement room for an agreed offer. Come back here any time to withdraw or recover funds."
                />
              )}
            </section>
          )}
        </>
      )}
    </OtcGrid>
  );
}

function StatusTag({ tone, label }: { tone: 'done' | 'waiting'; label: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 border px-1.5 py-0.5 font-term text-[10px] uppercase tracking-[0.1em]',
        tone === 'done' ? 'border-emerald/30 text-emerald' : 'border-neutral-700 text-neutral-300'
      )}
    >
      {tone === 'done' ? (
        <OtcIcon name="ph--check" className="h-3 w-3" />
      ) : (
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-neutral-400" />
      )}
      {label}
    </span>
  );
}

/** Decorative preview of an offer ticket, shown before the desk is unlocked. */
function SampleTicket() {
  return (
    <div aria-hidden="true" className="relative select-none">
      <div className="border border-neutral-800 bg-neutral-950">
        <div className="flex items-center justify-between border-b border-neutral-850 px-4 py-2.5">
          <span className="font-term text-[10px] uppercase tracking-[0.14em] text-neutral-500">
            Private offer
          </span>
          <span className="flex items-center gap-1.5 font-term text-[10px] uppercase tracking-[0.14em] text-primary">
            <OtcIcon name="ph--lock-simple" className="h-3 w-3" /> Sealed
          </span>
        </div>
        <div className="space-y-4 px-4 py-4">
          <TicketLeg label="You send" asset="SOL" width="w-24" />
          <div className="flex items-center gap-2 text-neutral-600">
            <span className="h-px flex-1 bg-neutral-850" />
            <OtcIcon name="ph--arrows-down-up" className="h-4 w-4" />
            <span className="h-px flex-1 bg-neutral-850" />
          </div>
          <TicketLeg label="You receive" asset="USDC" width="w-32" />
        </div>
        <div className="grid grid-cols-2 border-t border-neutral-850 font-term text-[10px] uppercase tracking-[0.12em]">
          <span className="px-4 py-2.5 text-neutral-500">
            Expires <span className="text-neutral-300">1h</span>
          </span>
          <span className="border-l border-neutral-850 px-4 py-2.5 text-neutral-500">
            Viewer <span className="text-neutral-300">invited</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function TicketLeg({
  label,
  asset,
  width,
}: {
  label: string;
  asset: 'SOL' | 'USDC';
  width: string;
}) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[11px] text-neutral-500">{label}</p>
        <span className={cn('mt-1.5 block h-6 bg-neutral-300/80', width)} />
      </div>
      <span className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
        <OtcAssetMark asset={asset} className="h-5 w-5 text-[11px]" />
        {asset}
      </span>
    </div>
  );
}

function DeskSpecs({ settlement }: { settlement: boolean }) {
  const rows: [string, string][] = [
    ['Pairs', settlement ? 'SOL · USDC · launchpad tokens' : 'SOL · USDC'],
    ['Price', 'Fixed by both amounts'],
    ['Expiry', Object.values(OTC_EXPIRIES).join(' · ')],
    ['Creating', 'Free · no transaction'],
    ...(settlement
      ? ([['Fee reserve', `${OTC_FEE_RESERVE / 1e9} SOL, unused returned`]] as [string, string][])
      : []),
  ];
  return (
    <aside aria-label="Desk terms" className={cn(otcPanel, 'px-5 py-4')}>
      <h2 className="font-display text-[13px] uppercase">At a glance</h2>
      <dl className="mt-2 divide-y divide-neutral-850">
        {rows.map(([name, value]) => (
          <div key={name} className="flex items-baseline justify-between gap-4 py-2.5">
            <dt className="font-term text-[10px] uppercase tracking-[0.12em] text-neutral-500">
              {name}
            </dt>
            <dd className="text-right text-xs text-neutral-200">{value}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}

function EmptyDesk({
  icon,
  title,
  text,
  action,
}: {
  icon: `ph--${string}`;
  title: string;
  text: string;
  action?: () => void;
}) {
  return (
    <div className="flex flex-col items-center border border-dashed border-neutral-800 px-6 py-10 text-center">
      <OtcIcon name={icon} className="h-8 w-8 text-neutral-700" />
      <p className="mt-3 font-display text-[13px] uppercase">{title}</p>
      <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-neutral-400">{text}</p>
      {action && (
        <Button type="button" variant="outline" size="sm" className="mt-5" onClick={action}>
          <OtcIcon name="ph--plus" className="h-3.5 w-3.5" /> New offer
        </Button>
      )}
    </div>
  );
}
