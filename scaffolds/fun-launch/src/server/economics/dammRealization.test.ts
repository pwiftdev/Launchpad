import { describe, expect, it, vi } from 'vitest';
vi.mock('../dbc', () => ({ connection: {}, networkGenesis: vi.fn() }));
import {
  canonicalSlotOrder,
  replayDammPosition,
  restoreDammReplayState,
  serializeDammReplayState,
  type DammReplayEvent,
} from './dammRealization';
const position = 'program-position',
  external = 'outside-position',
  L = 73639403199540124088919251228853n,
  Q = 1n << 128n;
const event = (name: string, data: Record<string, unknown>, signature = name): DammReplayEvent => ({
  name,
  data,
  signature,
});
const init = (liquidity = L) => event('EvtInitializePool', { liquidity });
const swap = (fee: bigint) =>
  event('EvtSwap2', {
    collect_fee_mode: 1,
    swap_result: { claiming_fee: fee, compounding_fee: 0n },
  });
const claim = (amount: bigint, signature = 'claim') =>
  event('EvtClaimPositionFee', { position, fee_b_claimed: amount, fee_a_claimed: 0n }, signature);
const liquidity = (delta: bigint, change_type: number) =>
  event('EvtLiquidityChange', { position: external, liquidity_delta: delta, change_type });
describe('exact canonical-position fee realization', () => {
  it('restores closed actual-claim state and matches a full replay after outside LP changes', () => {
    const first = [init(), swap(2_000_000n), claim(1_999_999n, 'first-claim')];
    const suffix = [
      liquidity(L, 0),
      swap(3n),
      swap(3n),
      liquidity(L, 1),
      claim(2n, 'second-claim'),
      swap(2_000_000n),
    ];
    const completed = replayDammPosition(first, position, L).completedCheckpoint!;
    const restored = restoreDammReplayState(
      JSON.parse(JSON.stringify(serializeDammReplayState(completed.state)))
    );
    const continued = replayDammPosition(suffix, position, L, undefined, restored),
      full = replayDammPosition([...first, ...suffix], position, L);
    for (const field of [
      'liquidity',
      'growth',
      'checkpoint',
      'claimed',
      'raw',
      'external',
      'rounding',
      'roundingBound',
      'eventCount',
      'windows',
      'pending',
      'diluted',
    ] as const)
      expect(continued[field]).toEqual(full[field]);
    expect(continued.attributions.map((x) => x.realized)).toEqual(
      full.attributions.slice(1).map((x) => x.realized)
    );
    expect(() =>
      replayDammPosition(suffix, position, L, undefined, { ...restored, raw: restored.raw + 1n })
    ).toThrow('closed actual claim');
  });
  it('never checkpoints a transaction that trades again after its claim', () => {
    const claimEvent = claim(1_999_999n, 'atomic-claim-and-trade'),
      trade = { ...swap(2n), signature: 'atomic-claim-and-trade' };
    expect(
      replayDammPosition([init(), swap(2_000_000n), claimEvent, trade], position, L)
        .completedCheckpoint
    ).toBeUndefined();
  });
  it('refuses partial or duplicate same-slot transaction order', () => {
    expect(() => canonicalSlotOrder(['first'], ['first', 'second'])).toThrow('canonical');
    expect(() => canonicalSlotOrder(['first', 'first'], ['first'])).toThrow('canonical');
    expect([...canonicalSlotOrder(['second', 'first'], ['first', 'second']).entries()]).toEqual([
      ['second', 0],
      ['first', 1],
    ]);
  });
  it('reproduces the real two-event4M to3,999,999 claim without fabricating a lamport', () => {
    const replay = replayDammPosition(
      [init(), swap(2_000_000n), swap(2_000_000n), claim(3_999_999n)],
      position,
      L
    );
    expect(replay).toMatchObject({
      raw: 4_000_000n,
      claimed: 3_999_999n,
      pending: 0n,
      external: 0n,
      rounding: 1n,
      roundingBound: 1n,
      windows: 1,
    });
    expect(replay.attributions.map((item) => item.realized)).toEqual([1_999_999n, 2_000_000n]);
    const pending = replayDammPosition([init(), swap(2_000_000n)], position, L);
    expect(pending.attributions[0]?.realized).toBe(replay.attributions[0]?.realized);
  });
  it('sums the floor losses of actual separate claim/checkpoint windows', () => {
    const replay = replayDammPosition(
      [
        init(),
        swap(2_000_000n),
        claim(1_999_999n, 'first'),
        swap(2_000_000n),
        claim(1_999_999n, 'second'),
      ],
      position,
      L
    );
    expect(replay).toMatchObject({
      raw: 4_000_000n,
      claimed: 3_999_998n,
      rounding: 2n,
      roundingBound: 2n,
      windows: 2,
    });
    expect(replay.claims).toEqual(['first', 'second']);
  });
  it('preserves a zero-cash dust event without inventing a lamport or re-crediting it later', () => {
    const first = replayDammPosition([init(), swap(1n)], position, L);
    const later = replayDammPosition([init(), swap(1n), swap(1n)], position, L);
    expect(first.attributions[0]?.realized).toBe(0n);
    expect(later.attributions.map((item) => item.realized)).toEqual([0n, 1n]);
    expect(later.raw).toBe(later.external + later.rounding + later.pending);
  });
  it('reconstructs outside liquidity and preserves fractional fee carry until the actual claim', () => {
    const own = Q / 4n;
    const replay = replayDammPosition(
      [init(own), liquidity(own, 0), swap(3n), swap(3n), liquidity(own, 1), claim(3n)],
      position,
      own
    );
    expect(replay).toMatchObject({
      raw: 6n,
      claimed: 3n,
      external: 3n,
      rounding: 0n,
      liquidity: own,
      diluted: true,
    });
    expect(replay.raw).toBe(replay.external + replay.rounding + replay.claimed + replay.pending);
    expect(replay.attributions.map((item) => item.realized)).toEqual([1n, 2n]);
    expect(
      replay.attributions.every(
        (item) => item.raw === item.realized + item.externalLpExcluded + item.roundingLoss
      )
    ).toBe(true);
  });
  it('keeps indivisible shared-LP dust outside actual payable SOL', () => {
    const own = Q / 4n,
      replay = replayDammPosition(
        [init(own), liquidity(own, 0), swap(3n), claim(1n)],
        position,
        own
      );
    expect(replay).toMatchObject({ raw: 3n, claimed: 1n, external: 1n, rounding: 1n });
  });
  it('bounds pool-wide quantization residual rather than using the tiny owned fraction as a bound', () => {
    const events = [init(1n), liquidity(Q / 2n, 0), ...Array.from({ length: 20 }, () => swap(1n))];
    const replay = replayDammPosition(events, position, 1n);
    expect(replay).toMatchObject({ raw: 20n, pending: 0n, external: 10n, rounding: 10n });
    expect(replay.roundingBound >= replay.rounding).toBe(true);
  });
  it('rejects a fabricated claim or mutation of the immutable fee position', () => {
    expect(() =>
      replayDammPosition([init(), swap(2_000_000n), claim(2_000_000n)], position, L)
    ).toThrow('claim differs');
    expect(() =>
      replayDammPosition(
        [init(), event('EvtLiquidityChange', { position, liquidity_delta: 1n, change_type: 0 })],
        position,
        L
      )
    ).toThrow('immutable');
  });
});
