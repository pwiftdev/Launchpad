import { describe, expect, it } from 'vitest';
import { allocateExecutedFee, allocateHolderSnapshot } from './feeLedger';

describe('upcoming executed-fee accounting', () => {
  it('routes Bond it. fees as 0.95% burn/0.05% operations before bonding and 0.50% creator/0.30% treasury afterward', () => {
    const common = { mode: 'bond' as const, activationTime: 0, tradeTime: 1_800_000_000 };
    expect(
      allocateExecutedFee({ ...common, total: 12_500_000n, protocol: 2_500_000n, phase: 'rinse' })
    ).toEqual({
      protocol: 2_500_000n,
      referral: 0n,
      rinseBuyback: 9_500_000n,
      platform: 500_000n,
      creator: 0n,
      community: 0n,
    });
    expect(
      allocateExecutedFee({ ...common, total: 10_000_000n, protocol: 2_000_000n, phase: 'post' })
    ).toEqual({
      protocol: 2_000_000n,
      referral: 0n,
      rinseBuyback: 0n,
      platform: 3_000_000n,
      creator: 5_000_000n,
      community: 0n,
    });
    expect(() => allocateExecutedFee({ ...common, total: 1n, protocol: 0n })).toThrow('verified');
  });
  it('preserves Bond it. rounding across tiny batches and does not infer graduation from elapsed time', () => {
    for (const phase of ['rinse', 'post'] as const) {
      let destination = 0n;
      for (let i = 0n; i < 101n; i++) {
        const a = allocateExecutedFee({
          total: 1n,
          protocol: 0n,
          activationTime: 0,
          tradeTime: 1_800_000_000,
          mode: 'bond',
          phase,
          previousPhaseNet: i,
        });
        destination += a.rinseBuyback + a.creator;
        expect(a.community).toBe(0n);
      }
      expect(destination).toBe(phase === 'rinse' ? 95n : 63n);
    }
  });
  it('preserves cumulative phase rounding independently of batch size and treats verified migrated fees as post-RINSE', () => {
    for (const phase of ['rinse', 'post'] as const) {
      let previous = 0n,
        destination = 0n;
      for (let i = 0; i < 101; i++) {
        const result = allocateExecutedFee({
          total: 1n,
          protocol: 0n,
          activationTime: 1000,
          tradeTime: 1001,
          mode: 'creator',
          phase,
          previousPhaseNet: previous,
        });
        destination += result.rinseBuyback + result.creator;
        previous++;
      }
      const batch = allocateExecutedFee({
        total: 101n,
        protocol: 0n,
        activationTime: 1000,
        tradeTime: 1001,
        mode: 'creator',
        phase,
      });
      expect(destination).toBe(batch.rinseBuyback + batch.creator);
      expect(destination).toBe(phase === 'rinse' ? 80n : 50n);
      if (phase === 'post') expect(batch.rinseBuyback).toBe(0n);
    }
  });
  it('reserves RINSE budgets for buybacks in both modes, not holder payouts', () => {
    for (const mode of ['creator', 'community'] as const) {
      const result = allocateExecutedFee({
        total: 700_000_000n,
        protocol: 140_000_000n,
        activationTime: 1000,
        tradeTime: 1026,
        mode,
      });
      expect(result.rinseBuyback).toBe(448_000_000n);
      expect(result.creator).toBe(0n);
      expect(result.community).toBe(0n);
      expect(Object.values(result).reduce((sum, value) => sum + value, 0n)).toBe(700_000_000n);
    }
  });
  it('switches at the exact RINSE boundary and only then allocates the mode share', () => {
    const fee = { total: 12_500_000n, protocol: 2_500_000n, activationTime: 1000, tradeTime: 1027 };
    expect(allocateExecutedFee({ ...fee, mode: 'creator' }).creator).toBe(5_000_000n);
    const community = allocateExecutedFee({ ...fee, mode: 'community' });
    expect(community.community).toBe(5_000_000n);
    expect(community.rinseBuyback).toBe(0n);
    expect(allocateExecutedFee({ ...fee, tradeTime: 1000, mode: 'creator' }).creator).toBe(0n);
  });
  it('conserves every lamport, including referral and rounding amounts', () => {
    for (let total = 0n; total < 2000n; total++)
      for (const tradeTime of [1000, 1027]) {
        const result = allocateExecutedFee({
          total,
          protocol: total / 6n,
          referral: total / 20n,
          activationTime: 1000,
          tradeTime,
          mode: 'community',
        });
        expect(Object.values(result).reduce((sum, value) => sum + value, 0n)).toBe(total);
      }
    expect(() =>
      allocateExecutedFee({
        total: 1n,
        protocol: 2n,
        activationTime: 1000,
        tradeTime: 1027,
        mode: 'creator',
      })
    ).toThrow();
    expect(() =>
      allocateExecutedFee({
        total: 1n,
        protocol: 0n,
        activationTime: 1000,
        tradeTime: 999,
        mode: 'creator',
      })
    ).toThrow();
  });
});

describe('hourly holder allocation', () => {
  it('aggregates accounts by owner, excludes vaults and carries indivisible dust forward', () => {
    const snapshot = {
      complete: true,
      finalized: true,
      excluded: new Set(['pool']),
      balances: [
        { wallet: 'a', tokens: 1n },
        { wallet: 'a', tokens: 1n },
        { wallet: 'b', tokens: 1n },
        { wallet: 'pool', tokens: 100000n },
      ],
    };
    expect(allocateHolderSnapshot(10n, snapshot)).toEqual({
      allocations: [
        { wallet: 'a', lamports: 6n },
        { wallet: 'b', lamports: 3n },
      ],
      carryForward: 1n,
    });
    expect(allocateHolderSnapshot(10n, { ...snapshot, balances: [] })).toEqual({
      allocations: [],
      carryForward: 10n,
    });
    expect(() => allocateHolderSnapshot(10n, { ...snapshot, complete: false })).toThrow();
    expect(() => allocateHolderSnapshot(10n, { ...snapshot, finalized: false })).toThrow();
  });
});
