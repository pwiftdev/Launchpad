import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  OtcExpiryTime,
  OtcFeedback,
  OtcGrid,
  OtcIcon,
  OtcPanelHead,
  OtcPrivacy,
  otcFeature,
  otcLabel,
} from './OtcLayout';
import { DealActivity, DealFundingBreakdown, DealParties, DealStepper } from './OtcDealDetails';
import { OtcTermsCard } from './OtcTermsCard';
import { dealProgress, type DealAction, type DealRetry } from './otcDealProgress';
import { settlementId, useOtcRingsDeal } from './useOtcRingsDeal';

const working: Record<DealAction | DealRetry | 'refresh', string> = {
  refresh: 'Checking status…',
  unlock: 'Waiting for wallet signature…',
  fund: 'Preparing or submitting your deposit…',
  prove: 'Preparing your private transfer…',
  prepare: 'Preparing settlement…',
  sign: 'Verifying and signing settlement…',
  settle: 'Submitting settlement…',
  withdraw: 'Preparing or submitting withdrawal…',
  'return-reserve': 'Returning unused SOL…',
  'retry-funding': 'Checking whether funding can be retried…',
  'retry-attempt': 'Checking whether settlement can be retried…',
  'retry-withdrawal': 'Checking whether withdrawal can be retried…',
  'retry-reserve': 'Checking whether the SOL return can be retried…',
};

export default function OtcRingsDeal({
  id,
  wallet,
  onBack,
  enabled,
}: {
  id: string;
  wallet: string;
  onBack: () => void;
  enabled: boolean;
}) {
  const {
    room,
    opening,
    checks,
    unlocked,
    now,
    busy,
    runningAction,
    error,
    notice,
    statusStale,
    load,
    act,
  } = useOtcRingsDeal(id, wallet, enabled);
  const back = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="-ml-2"
      onClick={onBack}
      disabled={busy}
    >
      <OtcIcon name="ph--arrow-left" className="h-4 w-4" /> Back to desk
    </Button>
  );
  if (!room)
    return (
      <OtcGrid aside={<OtcPrivacy settlement />}>
        <section className={cn(otcFeature, 'space-y-5 p-5 sm:p-8')} aria-busy={busy}>
          {back}
          <OtcPanelHead eyebrow="Settlement room" title="Open your deal" icon="ph--handshake">
            Use the wallet that agreed to the offer. Opening a deal lets you check progress and
            recover eligible funds.
          </OtcPanelHead>
          <OtcFeedback error={error} />
          <Button type="button" size="lg" variant="holo" onClick={load} disabled={busy || opening}>
            {busy || opening ? 'Opening deal…' : 'Open deal'}{' '}
            <OtcIcon name="ph--arrow-right" className="h-4 w-4" />
          </Button>
        </section>
      </OtcGrid>
    );

  const progress = dealProgress(room, checks, settlementId(room), unlocked, enabled, now);
  const next = progress.action ?? progress.retry;
  const outcome = progress.outcome === 'recovered' || progress.outcome === 'withdrawn';
  return (
    <div className="space-y-4" aria-busy={busy}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {back}
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={load}>
          <OtcIcon name="ph--arrows-clockwise" className="h-4 w-4" /> Refresh status
        </Button>
      </div>
      <DealStepper progress={progress} />
      <OtcGrid
        aside={
          <>
            <DealParties progress={progress} />
            <OtcPrivacy settlement />
          </>
        }
      >
        <section className={cn(otcFeature, 'overflow-hidden')}>
          <div className="space-y-4 border-b border-neutral-850 p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className={otcLabel}>Deal terms</h2>
              <p className="flex items-center gap-1.5 text-xs text-neutral-400">
                <OtcIcon name="ph--clock" className="h-4 w-4" />
                <span>{progress.expired ? 'Deadline passed' : 'Offer deadline'}</span>{' '}
                <OtcExpiryTime date={room.expiresAt} />
              </p>
            </div>
            <OtcTermsCard terms={room.terms} guest={room.side === 'taker'} />
          </div>
          <div className="space-y-4 p-5 sm:p-6">
            <div aria-live="polite" className="flex items-start gap-3">
              <span
                className={cn(
                  'inline-flex h-10 w-10 shrink-0 items-center justify-center border',
                  outcome
                    ? 'border-emerald/30 bg-emerald/10 text-emerald'
                    : 'border-primary/30 bg-primary/10 text-primary'
                )}
              >
                <OtcIcon
                  name={outcome ? 'ph--check' : next ? 'ph--arrow-right' : 'ph--hourglass'}
                  className="h-4 w-4"
                />
              </span>
              <div className="min-w-0">
                <p className="eyebrow mb-1.5">{outcome ? 'Done' : next ? 'Next step' : 'Status'}</p>
                <h3 className="font-display text-lg uppercase leading-tight sm:text-xl">
                  {progress.title}
                </h3>
                <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-neutral-400">
                  {progress.detail}
                </p>
              </div>
            </div>
            {progress.fundingBreakdown && <DealFundingBreakdown room={room} />}
            {statusStale && (
              <OtcFeedback notice="Live status is temporarily unavailable. Use Refresh status to check again." />
            )}
            <OtcFeedback error={error} notice={runningAction ? working[runningAction] : notice} />
            {next && (
              <Button
                type="button"
                size="lg"
                variant={progress.retry ? 'outline' : 'holo'}
                className="min-h-11 w-full whitespace-normal py-2 sm:w-auto"
                disabled={busy}
                onClick={() => act(next.id)}
              >
                {next.label}
                <OtcIcon
                  name={progress.retry ? 'ph--arrow-counter-clockwise' : 'ph--arrow-right'}
                  className="h-4 w-4"
                />
              </Button>
            )}
          </div>
        </section>
        <DealActivity room={room} progress={progress} settlementSignature={settlementId(room)} />
      </OtcGrid>
    </div>
  );
}
