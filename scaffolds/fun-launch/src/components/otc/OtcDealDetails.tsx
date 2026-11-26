import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { NETWORK_GENESIS } from '../../../../../scripts/network-policy.cjs';
import { OTC_FEE_RESERVE, otcAmountUnits, otcAssetLabel } from '@/lib/otc';
import { otherRingsSide, type RingsRoom } from '@/lib/otcRingsRoom';
import { cn } from '@/lib/utils';
import { OtcIcon, otcInset, otcPanel } from './OtcLayout';
import { dealStages, type ChainCheck, type dealProgress } from './otcDealProgress';

type Progress = ReturnType<typeof dealProgress>;

export function DealStepper({ progress }: { progress: Progress }) {
  return (
    <ol
      aria-label="Deal progress"
      className="grid grid-cols-5 gap-px border border-white/[0.08] bg-white/[0.08]"
    >
      {dealStages.map(({ id, label }, index) => {
        const complete = progress.complete[id];
        const current = progress.stage === id && !progress.outcome;
        return (
          <li
            key={id}
            aria-current={current ? 'step' : undefined}
            className={cn(
              'relative min-w-0 bg-panel px-2 py-3 text-center sm:px-4 sm:py-3.5 sm:text-left',
              current && 'bg-primary/[0.06]'
            )}
          >
            {current && (
              <span aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-primary" />
            )}
            <span className="flex flex-col items-center gap-1.5 sm:flex-row sm:justify-between">
              <span
                className={cn(
                  'font-pixel text-[18px] leading-none sm:text-[20px]',
                  current ? 'text-primary' : complete ? 'text-neutral-300' : 'text-neutral-600'
                )}
              >
                {String(index + 1).padStart(2, '0')}
              </span>
              <OtcIcon
                name={complete ? 'ph--check' : current ? 'ph--circle-half' : 'ph--circle'}
                className={cn(
                  'hidden h-4 w-4 sm:block',
                  complete ? 'text-emerald' : current ? 'text-primary' : 'text-neutral-600'
                )}
              />
            </span>
            <span
              className={cn(
                'mt-2 block truncate font-term text-[10px] uppercase tracking-[0.1em] sm:text-[11px]',
                current ? 'text-foreground' : complete ? 'text-neutral-300' : 'text-neutral-500'
              )}
            >
              {label}
              {complete && <span className="sr-only"> complete</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

const chainLabel: Record<ChainCheck, string> = {
  missing: 'Not started',
  unchecked: 'Checking Solana',
  unseen: 'Signature saved',
  pending: 'Confirming',
  finalized: 'Finalized',
  failed: 'Failed on-chain',
};

function partyStage(
  progress: Progress,
  side: 'own' | 'other'
): { text: string; state: 'ready' | 'waiting' | 'failed' } {
  const you = side === 'own';
  const mark = (ready: boolean, label: string) => ({
    text: ready ? label : 'Waiting',
    state: ready ? ('ready' as const) : ('waiting' as const),
  });
  switch (progress.stage) {
    case 'unlock':
      return mark(you ? progress.ownReady : progress.otherReady, 'Deal wallet registered');
    case 'fund': {
      const check = you ? progress.funding : progress.otherFunding;
      return {
        text: chainLabel[check],
        state: check === 'finalized' ? 'ready' : check === 'failed' ? 'failed' : 'waiting',
      };
    }
    case 'prepare':
      return mark(you ? progress.minePrepared : progress.otherPrepared, 'Transfer prepared');
    case 'settle':
      return mark(you ? progress.mineSigned : progress.otherSigned, 'Settlement signed');
    case 'withdraw':
      return {
        text: you
          ? chainLabel[progress.withdrawal]
          : progress.settled
            ? 'Swap finalized'
            : 'Manages their own deposit',
        state:
          (you && progress.withdrawal === 'finalized') || (!you && progress.settled)
            ? 'ready'
            : you && progress.withdrawal === 'failed'
              ? 'failed'
              : 'waiting',
      };
  }
}

export function DealParties({ progress }: { progress: Progress }) {
  return (
    <aside className={cn(otcPanel, 'px-5 py-4')} aria-label="Wallet progress">
      <h2 className="mb-2 font-display text-[13px] uppercase">Wallet progress</h2>
      <dl className="divide-y divide-neutral-850">
        {(['own', 'other'] as const).map((side) => {
          const { state, text } = partyStage(progress, side);
          return (
            <div
              key={side}
              className="flex min-w-0 items-center justify-between gap-2 py-2.5 last:pb-0"
            >
              <dt className="text-sm text-neutral-200">
                {side === 'own' ? 'You' : 'Counterparty'}
              </dt>
              <dd
                className={cn(
                  'flex items-center gap-1.5 text-right text-xs',
                  state === 'ready'
                    ? 'text-emerald'
                    : state === 'failed'
                      ? 'text-rose'
                      : 'text-neutral-300'
                )}
              >
                <OtcIcon
                  name={
                    state === 'ready'
                      ? 'ph--check'
                      : state === 'failed'
                        ? 'ph--warning-circle'
                        : 'ph--clock'
                  }
                  className="h-3.5 w-3.5"
                />
                {text}
              </dd>
            </div>
          );
        })}
      </dl>
    </aside>
  );
}

function fundingSol(lamports: bigint) {
  const unit = BigInt(LAMPORTS_PER_SOL);
  const fraction = (lamports % unit).toString().padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${lamports / unit}.${fraction}` : String(lamports / unit);
}

export function DealFundingBreakdown({ room }: { room: RingsRoom }) {
  const leg = room.side === 'maker' ? room.terms.sell : room.terms.buy;
  const { asset, amount } = leg;
  const label = otcAssetLabel(leg);
  const reserve = BigInt(OTC_FEE_RESERVE);
  const sol = asset === 'SOL' ? otcAmountUnits(asset, amount) : null;
  const total =
    sol === null
      ? `${amount} ${label} + ${fundingSol(reserve)} SOL`
      : `${fundingSol(sol + reserve)} SOL`;
  return (
    <div className={cn(otcInset, 'divide-y divide-neutral-850 px-4')}>
      <dl className="space-y-2 py-3 text-sm">
        <FundingRow name="Public deposit" value={`${amount} ${label}`} />
        <FundingRow name="SOL held for fees and rent" value={`${fundingSol(reserve)} SOL`} />
      </dl>
      <dl className="py-3 text-sm font-semibold">
        <FundingRow
          name={
            asset === 'TOKEN'
              ? 'Wallet total before fees and any setup rent'
              : 'Wallet total before network fees'
          }
          value={total}
        />
      </dl>
      {asset === 'TOKEN' && (
        <p className="py-3 text-xs leading-relaxed text-neutral-300">
          The first Rings deposit for this token includes one-time account rent. Your wallet shows
          the total before you approve. The setup rent stays with the shared Rings accounts.
        </p>
      )}
      {asset !== 'TOKEN' &&
        [room.terms.sell, room.terms.buy].some((item) => item.asset === 'TOKEN') && (
          <p className="py-3 text-xs text-neutral-300">
            If the token needs Rings setup, the token holder funds first.
          </p>
        )}
    </div>
  );
}

function FundingRow({ name, value }: { name: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <dt className="text-xs text-neutral-300 sm:text-sm">{name}</dt>
      <dd className="break-all text-right font-mono text-xs font-medium sm:text-sm">{value}</dd>
    </div>
  );
}

function explorerLink(room: RingsRoom, signature: string) {
  if (room.genesis === NETWORK_GENESIS['mainnet-beta'])
    return `https://explorer.solana.com/tx/${signature}`;
  if (room.genesis === NETWORK_GENESIS.devnet)
    return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
  return undefined;
}

export function DealActivity({
  room,
  progress,
  settlementSignature,
}: {
  room: RingsRoom;
  progress: Progress;
  settlementSignature?: string;
}) {
  const own = room[room.side];
  const other = room[otherRingsSide(room.side)];
  const rows = [
    { label: 'Your funding', signature: own.funding?.signature, status: progress.funding },
    {
      label: 'Counterparty funding',
      signature: other.funding?.signature,
      status: progress.otherFunding,
    },
    { label: 'Settlement', signature: settlementSignature, status: progress.settlement },
    { label: 'Your withdrawal', signature: own.withdrawal?.signature, status: progress.withdrawal },
    { label: 'Unused SOL return', signature: own.reserve?.signature, status: progress.reserve },
  ].filter((row) => row.signature);
  if (!rows.length) return null;
  return (
    <details className={cn(otcPanel, 'px-5 py-3')}>
      <summary className="cursor-pointer py-1.5 font-display text-[13px] uppercase transition-colors hover:text-primary">
        Transaction activity
      </summary>
      <ul className="mt-1 divide-y divide-neutral-850">
        {rows.map(({ label, signature, status }) => {
          const link =
            signature && ['pending', 'finalized', 'failed'].includes(status)
              ? explorerLink(room, signature)
              : undefined;
          return (
            <li
              key={label}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5 text-xs"
            >
              <span className="text-neutral-200">{label}</span>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-neutral-300">{chainLabel[status]}</span>
                {link && (
                  <a
                    href={link}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`View ${label.toLowerCase()} on Solana Explorer`}
                    className="inline-flex items-center gap-1 rounded-sm text-primary-200 hover:underline"
                  >
                    Explorer <OtcIcon name="ph--arrow-up-right" className="h-3 w-3" />
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
