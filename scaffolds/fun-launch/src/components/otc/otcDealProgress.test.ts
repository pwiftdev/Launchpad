import { describe, expect, it } from 'vitest';
import type { RingsFunding, RingsRoom } from '@/lib/otcRingsRoom';
import { dealProgress, type DealChecks } from './otcDealProgress';

const open = Date.parse('2026-11-25T10:00:00.000Z');
const expiresAt = new Date(open + 120_000).toISOString();
const empty: RingsRoom['maker'] = {
  key: null,
  funding: null,
  proof: null,
  withdrawal: null,
  reserve: null,
};
const room: RingsRoom = {
  id: 'fixture',
  genesis: 'fixture',
  origin: 'https://mskd.fun',
  side: 'maker',
  expiresAt,
  terms: { sell: { asset: 'SOL', amount: '0.1' }, buy: { asset: 'USDC', amount: '12' } },
  maker: empty,
  taker: empty,
  attempt: null,
};
const lifetime = { blockhash: 'fixture', lastValidBlockHeight: '100' };
const packet = (signature: string): RingsFunding => ({
  ...lifetime,
  signature,
  transaction: 'test',
});
const maker = { ...empty, key: 'maker', funding: packet('maker funding') };
const taker = { ...empty, key: 'taker', funding: packet('taker funding') };
const funded = { ...room, maker, taker };
const prepared = {
  ...room,
  maker: { ...maker, proof: 'maker proof' },
  taker: { ...taker, proof: 'taker proof' },
};
const partial = { message: 'settlement message', signature: 'partial' };
const signed = {
  ...prepared,
  attempt: { id: 'attempt', lifetime, maker: partial, taker: partial },
};
const known = (
  entries: [string, 'finalized' | 'pending' | 'unseen' | 'failed'][],
  finalizedHeight = 99n
): DealChecks => ({
  bySignature: new Map(entries),
  finalizedHeight,
});
const confirmed = known([
  ['maker funding', 'finalized'],
  ['taker funding', 'finalized'],
]);
const expired = Date.parse(expiresAt);

describe('OTC deal guidance', () => {
  it('prompts each wallet to unlock and waits for the counterparty before allowing funding', () => {
    expect(dealProgress(room, known([]), undefined, false, true, open).action?.id).toBe('unlock');
    const awaitingTaker = { ...room, maker: { ...empty, key: 'maker' } };
    expect(dealProgress(awaitingTaker, known([]), undefined, true, true, open)).toMatchObject({
      stage: 'unlock',
      title: 'Waiting for your counterparty',
      ownReady: true,
      otherReady: false,
    });
    const ready = { ...awaitingTaker, taker: { ...empty, key: 'taker' } };
    expect(dealProgress(ready, known([]), undefined, true, true, open)).toMatchObject({
      stage: 'fund',
      action: { label: 'Fund deal' },
      fundingBreakdown: true,
    });
    expect(
      dealProgress(ready, known([]), undefined, true, true, expired - 60_000).action
    ).toBeUndefined();
  });

  it('waits for chain finality on both deposits before offering proof preparation', () => {
    const waiting = known([
      ['maker funding', 'finalized'],
      ['taker funding', 'pending'],
    ]);
    expect(dealProgress(funded, waiting, undefined, true, true, open)).toMatchObject({
      stage: 'fund',
      title: 'Waiting for the other deposit',
      otherFunding: 'pending',
    });
    expect(dealProgress(funded, confirmed, undefined, true, true, open).action?.id).toBe('prove');
    expect(dealProgress(funded, confirmed, undefined, false, true, open).action?.id).toBe('unlock');
  });

  it('offers a resend for an ambiguous submission and a reset only after the lifetime ends', () => {
    const current = known([['maker funding', 'unseen']]);
    expect(dealProgress(funded, current, undefined, true, true, open).action?.label).toBe(
      'Resend signed funding'
    );
    expect(dealProgress(funded, current, undefined, true, true, open).retry).toBeUndefined();
    expect(
      dealProgress(funded, known([], 101n), undefined, true, true, open).retry
    ).toBeUndefined();
    const elapsed = known([['maker funding', 'unseen']], 101n);
    expect(dealProgress(funded, elapsed, undefined, true, true, open).retry?.id).toBe(
      'retry-funding'
    );
  });

  it('walks both wallets through signing and waits for settlement confirmation', () => {
    expect(dealProgress(prepared, confirmed, undefined, true, true, open).action?.id).toBe(
      'prepare'
    );
    const oneSignature: RingsRoom = { ...signed, attempt: { ...signed.attempt, taker: null } };
    expect(
      dealProgress(oneSignature, confirmed, undefined, true, true, open).action
    ).toBeUndefined();
    expect(
      dealProgress({ ...oneSignature, side: 'taker' }, confirmed, undefined, true, true, open)
        .action?.id
    ).toBe('sign');
    const ready = known([...confirmed.bySignature, ['settlement', 'unseen']]);
    expect(dealProgress(signed, ready, 'settlement', true, true, open).action?.id).toBe('settle');
    const pending = known([...confirmed.bySignature, ['settlement', 'pending']]);
    expect(dealProgress(signed, pending, 'settlement', true, true, expired).action).toBeUndefined();
    const finalized = known([...confirmed.bySignature, ['settlement', 'finalized']]);
    expect(dealProgress(signed, finalized, 'settlement', true, false, expired).action?.label).toBe(
      'Withdraw to my wallet'
    );
  });

  it('distinguishes an expired deal, a recovered deposit, and an unused SOL return', () => {
    expect(dealProgress(room, known([]), undefined, false, true, expired).outcome).toBe('expired');
    expect(dealProgress(funded, confirmed, undefined, true, false, expired).action?.label).toBe(
      'Recover deposit'
    );
    const withdrawn = { ...funded, maker: { ...maker, withdrawal: packet('withdrawal') } };
    const received = known([...confirmed.bySignature, ['withdrawal', 'finalized']]);
    expect(dealProgress(withdrawn, received, undefined, true, true, expired).action?.id).toBe(
      'return-reserve'
    );
    const returned = { ...withdrawn, maker: { ...withdrawn.maker, reserve: packet('return') } };
    const complete = known([...received.bySignature, ['return', 'finalized']]);
    expect(dealProgress(returned, complete, undefined, true, true, expired)).toMatchObject({
      outcome: 'recovered',
      complete: { settle: false, withdraw: true },
    });
  });
});
