import {
  otherRingsSide,
  type RingsAttempt,
  type RingsFunding,
  type RingsRoom,
} from '@/lib/otcRingsRoom';

export const dealStages = [
  { id: 'unlock', label: 'Unlock' },
  { id: 'fund', label: 'Fund' },
  { id: 'prepare', label: 'Prepare' },
  { id: 'settle', label: 'Settle' },
  { id: 'withdraw', label: 'Withdraw' },
] as const;

export type DealStage = (typeof dealStages)[number]['id'];
export type DealAction =
  'unlock' | 'fund' | 'prove' | 'prepare' | 'sign' | 'settle' | 'withdraw' | 'return-reserve';
export type DealRetry = 'retry-funding' | 'retry-attempt' | 'retry-withdrawal' | 'retry-reserve';
export type ChainCheck = 'missing' | 'unchecked' | 'unseen' | 'pending' | 'finalized' | 'failed';
type ObservedCheck = Exclude<ChainCheck, 'missing' | 'unchecked'>;
export type DealChecks = {
  bySignature: ReadonlyMap<string, ObservedCheck>;
  finalizedHeight?: bigint;
};

type Guidance = {
  stage: DealStage;
  title: string;
  detail: string;
  action?: { id: DealAction; label: string };
  retry?: { id: DealRetry; label: string };
  fundingBreakdown?: boolean;
  outcome?: 'withdrawn' | 'recovered' | 'expired';
};

const unlock = { id: 'unlock', label: 'Unlock deal wallet' } as const;

export function dealChainCheck(checks: DealChecks, signature?: string | null): ChainCheck {
  return signature ? (checks.bySignature.get(signature) ?? 'unchecked') : 'missing';
}

function retryReady(
  lifetime: RingsFunding | RingsAttempt['lifetime'] | null | undefined,
  check: ChainCheck,
  height?: bigint
) {
  return (
    !!lifetime &&
    (check === 'failed' ||
      ((check === 'unseen' || check === 'missing') &&
        height !== undefined &&
        height > BigInt(lifetime.lastValidBlockHeight)))
  );
}

function finishDeal({
  own,
  unlocked,
  settled,
  funding,
  settlement,
  withdrawal,
  reserve,
  height,
}: {
  own: RingsRoom['maker'];
  unlocked: boolean;
  settled: boolean;
  funding: ChainCheck;
  settlement: ChainCheck;
  withdrawal: ChainCheck;
  reserve: ChainCheck;
  height?: bigint;
}): Guidance {
  const stage = 'withdraw';
  if (withdrawal === 'finalized') {
    if (reserve === 'finalized') {
      return {
        stage,
        title: settled ? 'Your trade is complete' : 'Your funds were recovered',
        detail: 'Your withdrawal and the return of unused SOL are finalized on Solana.',
        outcome: settled ? 'withdrawn' : 'recovered',
      };
    }
    if (reserve === 'pending' || reserve === 'unchecked')
      return {
        stage,
        title: 'Returning unused SOL',
        detail: 'Your withdrawal is complete. The SOL return is waiting for final confirmation.',
      };
    const retry = retryReady(own.reserve, reserve, height);
    return {
      stage,
      title: 'Withdrawal finalized',
      detail: 'Return any SOL left in the deal wallet after fees and account rent.',
      action: retry
        ? undefined
        : !unlocked
          ? unlock
          : {
              id: 'return-reserve',
              label: own.reserve ? 'Resend SOL return' : 'Return unused SOL',
            },
      retry: retry ? { id: 'retry-reserve', label: 'Reset SOL return' } : undefined,
    };
  }
  if (!settled && ['pending', 'unchecked'].includes(settlement))
    return {
      stage,
      title: 'Checking settlement',
      detail: 'Wait for Solana to confirm the outcome before withdrawing.',
    };
  if (funding !== 'finalized') {
    if (
      ['pending', 'unchecked', 'unseen'].includes(funding) &&
      !retryReady(own.funding, funding, height)
    )
      return {
        stage,
        title: 'Checking your deposit',
        detail: 'A signed deposit was saved. If it finalizes, you can claim the funds here.',
      };
    return {
      stage,
      title: 'Offer expired',
      detail: 'There is no confirmed deposit to withdraw from this wallet.',
      outcome: 'expired',
    };
  }
  if (withdrawal === 'pending' || withdrawal === 'unchecked')
    return {
      stage,
      title: 'Withdrawal in progress',
      detail: 'Solana is confirming the transfer to your connected wallet.',
    };
  const retry = retryReady(own.withdrawal, withdrawal, height);
  return {
    stage,
    title: settled ? 'Withdraw your received funds' : 'Recover your deposit',
    detail: settled
      ? 'The swap settled. Move the asset you received to your connected wallet.'
      : 'The deadline passed before the swap settled. Withdraw your original deposit to your connected wallet.',
    action: retry
      ? undefined
      : !unlocked
        ? unlock
        : {
            id: 'withdraw',
            label: own.withdrawal
              ? 'Resend signed withdrawal'
              : settled
                ? 'Withdraw to my wallet'
                : 'Recover deposit',
          },
    retry: retry ? { id: 'retry-withdrawal', label: 'Reset withdrawal' } : undefined,
  };
}

export function dealProgress(
  room: RingsRoom,
  checks: DealChecks,
  settlementSignature: string | undefined,
  unlocked: boolean,
  enabled: boolean,
  now: number
) {
  const own = room[room.side];
  const other = room[otherRingsSide(room.side)];
  const funding = dealChainCheck(checks, own.funding?.signature);
  const otherFunding = dealChainCheck(checks, other.funding?.signature);
  const settlement = dealChainCheck(checks, settlementSignature);
  const withdrawal = dealChainCheck(checks, own.withdrawal?.signature);
  const reserve = dealChainCheck(checks, own.reserve?.signature);
  const expired = Date.parse(room.expiresAt) <= now;
  const settled = settlement === 'finalized';
  const keysReady = !!own.key && !!other.key;
  const bothFunded = funding === 'finalized' && otherFunding === 'finalized';
  const bothPrepared = !!own.proof && !!other.proof;
  const attempt = room.attempt;
  const mineSigned = !!attempt?.[room.side];
  const otherSigned = !!attempt?.[otherRingsSide(room.side)];
  const complete = {
    unlock: keysReady,
    fund: bothFunded,
    prepare: bothPrepared,
    settle: settled,
    withdraw: withdrawal === 'finalized' && reserve === 'finalized',
  };

  function next(): Guidance {
    if (settled || expired)
      return finishDeal({
        own,
        unlocked,
        settled,
        funding,
        settlement,
        withdrawal,
        reserve,
        height: checks.finalizedHeight,
      });
    if (!enabled)
      return {
        stage: keysReady ? 'fund' : 'unlock',
        title: 'New settlement actions are paused',
        detail: 'If you funded this deal and it expires, return here to recover your deposit.',
      };
    if (!keysReady)
      return own.key
        ? {
            stage: 'unlock',
            title: 'Waiting for your counterparty',
            detail: 'The other wallet must unlock the deal before either person can fund it.',
          }
        : {
            stage: 'unlock',
            title: 'Unlock your deal wallet',
            detail:
              'Sign a message to unlock the wallet used for this deal. No funds move at this step.',
            action: unlock,
          };
    if (!bothFunded) {
      if (funding === 'finalized')
        return {
          stage: 'fund',
          title: 'Waiting for the other deposit',
          detail: 'Your deposit is confirmed. Continue once both deposits are finalized.',
        };
      if (funding === 'unchecked' || funding === 'pending')
        return {
          stage: 'fund',
          title: 'Confirming your deposit',
          detail: 'We’re checking the funding transaction on Solana.',
        };
      if (retryReady(own.funding, funding, checks.finalizedHeight))
        return {
          stage: 'fund',
          title: 'Your deposit needs another attempt',
          detail: 'Reset the saved transaction, then fund again with a fresh wallet signature.',
          retry: { id: 'retry-funding', label: 'Reset funding' },
        };
      if (!own.funding && Date.parse(room.expiresAt) - now <= 60_000)
        return {
          stage: 'fund',
          title: 'Too close to the deadline',
          detail:
            'New deposits pause in the last minute. Create or request a fresh offer if you still want to trade.',
        };
      return {
        stage: 'fund',
        title: own.funding ? 'Your funding signature is saved' : 'Fund your side of the trade',
        detail: own.funding
          ? 'Solana hasn’t shown the deposit yet. Resend the same signed transaction.'
          : 'Review the public deposit amount and fee reserve before approving in your wallet.',
        action: unlocked
          ? { id: 'fund', label: own.funding ? 'Resend signed funding' : 'Fund deal' }
          : unlock,
        fundingBreakdown: !own.funding,
      };
    }
    if (!bothPrepared)
      return own.proof
        ? {
            stage: 'prepare',
            title: 'Waiting for the other transfer',
            detail: 'Your private transfer is ready. Your counterparty needs to prepare theirs.',
          }
        : {
            stage: 'prepare',
            title: 'Prepare your private transfer',
            detail:
              'Build the proof for your encrypted transfer. This takes a moment and does not move funds.',
            action: unlocked ? { id: 'prove', label: 'Prepare my private transfer' } : unlock,
          };
    if (settlement === 'pending' || settlement === 'unchecked')
      return {
        stage: 'settle',
        title: 'Settlement in progress',
        detail: 'One transaction moves both sides of the trade. Wait for final confirmation.',
      };
    if (retryReady(attempt?.lifetime, settlement, checks.finalizedHeight))
      return {
        stage: 'settle',
        title: 'Settlement needs another attempt',
        detail:
          'Reset the expired or failed transaction. Both wallets will prepare and sign again.',
        retry: { id: 'retry-attempt', label: 'Reset settlement' },
      };
    if (!attempt)
      return {
        stage: 'settle',
        title: 'Prepare one settlement',
        detail: 'Either party can prepare the transaction that settles both sides of the trade.',
        action: { id: 'prepare', label: 'Prepare settlement' },
      };
    if (!mineSigned)
      return {
        stage: 'settle',
        title: 'Verify and sign settlement',
        detail:
          'Your deal wallet verifies both amounts and recipients. Both signatures are required to submit the trade.',
        action: unlocked ? { id: 'sign', label: 'Verify and sign' } : unlock,
      };
    if (!otherSigned)
      return {
        stage: 'settle',
        title: 'Waiting for the other signature',
        detail:
          'You signed. Your counterparty still needs to verify and sign the same transaction.',
      };
    return {
      stage: 'settle',
      title: 'Both wallets have signed',
      detail: 'Either party can submit the single transaction. Both transfers settle together.',
      action: unlocked ? { id: 'settle', label: 'Submit settlement' } : unlock,
    };
  }

  return {
    ...next(),
    complete,
    expired,
    settled,
    funding,
    otherFunding,
    settlement,
    withdrawal,
    reserve,
    ownReady: !!own.key,
    otherReady: !!other.key,
    minePrepared: !!own.proof,
    otherPrepared: !!other.proof,
    mineSigned,
    otherSigned,
  };
}
