import { describe, it, expect, vi } from 'vitest';
import {
  runSchedulerTick,
  runSchedulerLoop,
  type SchedulerDependencies,
  type SchedulerLease,
} from './scheduler';
import { schedulerOptions, assertSchedulerNetwork } from './schedulerCli';
import { NETWORK_GENESIS } from '../../../../../scripts/network-policy.cjs';

const limits = { maximumCoins: 4, maximumReceiptsPerCoin: 2, concurrency: 1 };
function fixture() {
  let held = false,
    alive = true;
  const lease: SchedulerLease = {
    alive: () => alive,
    progress: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
    release: vi.fn(async () => {
      held = false;
    }),
  };
  const deps: SchedulerDependencies = {
    acquire: async () => {
      if (held) return null;
      held = true;
      return lease;
    },
    discover: async () => ['one', 'two'],
    pending: async () => ({ receipts: [], more: false }),
    reconcile: async () => 'finalized',
    plan: vi.fn(async () => 'planned' as const),
  };
  return {
    deps,
    lease,
    loseLock: () => {
      alive = false;
    },
  };
}
describe('unsigned scheduler lifecycle', () => {
  it('recovers persisted receipt work after a planner failure, without another signed attempt or send', async () => {
    const { deps } = fixture();
    let durable: 'absent' | 'submitted' | 'finalized' = 'absent',
      created = 0;
    deps.discover = async () => ['one'];
    deps.pending = async () => ({
      receipts: durable === 'submitted' ? [{ id: 'saved-signature', kind: 'operator' }] : [],
      more: false,
    });
    deps.plan = vi.fn(async () => {
      if (durable === 'absent') {
        durable = 'submitted';
        created++;
        throw new Error('process stopped after durable external receipt saved');
      }
      expect(durable).toBe('finalized');
      return 'planned' as const;
    });
    deps.reconcile = vi.fn(async (receipt) => {
      expect(receipt.id).toBe('saved-signature');
      durable = 'finalized';
      return 'finalized' as const;
    });
    expect((await runSchedulerTick(deps, limits)).failed).toBe(1);
    const recovered = await runSchedulerTick(deps, limits);
    expect(recovered).toMatchObject({
      status: 'completed',
      planned: 1,
      failed: 0,
      transactionsSigned: false,
      transactionsSent: false,
    });
    expect(created).toBe(1);
    expect(deps.reconcile).toHaveBeenCalledTimes(1);
  });
  it('keeps uncertain signatures reserved and contains per-coin provider errors without leaking them', async () => {
    const { deps, lease } = fixture();
    deps.discover = async () => ['uncertain', 'broken', 'healthy'];
    deps.pending = async (mint) => {
      if (mint === 'broken') throw new Error('postgres://private:password@provider');
      return { receipts: mint === 'uncertain' ? [{ id: 'saved', kind: 'job' }] : [], more: false };
    };
    deps.reconcile = async () => 'pending';
    const result = await runSchedulerTick(deps, limits);
    expect(result).toMatchObject({ processed: 3, pending: 1, failed: 1, planned: 1 });
    expect(deps.plan).toHaveBeenCalledExactlyOnceWith('healthy');
    expect(JSON.stringify(result)).not.toMatch(/password|provider|postgres/);
    expect(lease.progress).toHaveBeenLastCalledWith('healthy', 3, 1);
    expect(lease.release).toHaveBeenCalledTimes(1);
  });
  it('excludes overlapping runs and bounds concurrency while a slow request is in flight', async () => {
    const { deps, lease } = fixture();
    let release!: () => void,
      started!: () => void,
      active = 0,
      maximum = 0;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        started = resolve;
      });
    deps.discover = async () => ['a', 'b', 'c', 'd'];
    deps.plan = async () => {
      active++;
      maximum = Math.max(maximum, active);
      if (active === 2) started();
      await gate;
      active--;
      return 'planned' as const;
    };
    const first = runSchedulerTick(deps, { ...limits, concurrency: 2 });
    await ready;
    expect((await runSchedulerTick(deps, limits)).status).toBe('busy');
    release();
    expect((await first).processed).toBe(4);
    expect(maximum).toBe(2);
    expect(lease.release).toHaveBeenCalledTimes(1);
  });
  it('stops new work on signals or lost locks and always releases its session', async () => {
    const first = fixture(),
      controller = new AbortController();
    first.deps.plan = vi.fn(async () => {
      controller.abort();
      return 'planned' as const;
    });
    expect((await runSchedulerTick(first.deps, limits, controller.signal)).status).toBe('stopped');
    expect(first.deps.plan).toHaveBeenCalledTimes(1);
    expect(first.lease.progress).toHaveBeenCalledExactlyOnceWith('one', 1, 0);
    const second = fixture();
    second.deps.plan = vi.fn(async () => {
      second.loseLock();
      return 'planned' as const;
    });
    expect((await runSchedulerTick(second.deps, limits)).status).toBe('stopped');
    expect(second.deps.plan).toHaveBeenCalledTimes(1);
    expect(second.lease.progress).not.toHaveBeenCalled();
    expect(second.lease.release).toHaveBeenCalledTimes(1);
  });
  it('never begins planning when a bounded receipt backlog remains, or discovery fails', async () => {
    const { deps, lease } = fixture();
    deps.pending = async () => ({ receipts: [], more: true });
    expect((await runSchedulerTick(deps, limits)).pending).toBe(2);
    expect(deps.plan).not.toHaveBeenCalled();
    deps.discover = async () => {
      throw new Error('private RPC failure');
    };
    expect((await runSchedulerTick(deps, limits)).status).toBe('failed');
    expect(lease.release).toHaveBeenCalledTimes(2);
  });
  it('runs finite sequential cycles and interrupts an interval promptly', async () => {
    const { deps } = fixture(),
      controller = new AbortController(),
      tick = vi.fn(() => runSchedulerTick(deps, limits, controller.signal)),
      emit = vi.fn();
    await runSchedulerLoop({
      tick,
      emit,
      maximumCycles: 3,
      intervalMs: 1000,
      signal: controller.signal,
      wait: async () => {},
    });
    expect(tick).toHaveBeenCalledTimes(3);
    expect(emit).toHaveBeenCalledTimes(3);
    const stopped = new AbortController();
    await runSchedulerLoop({
      tick,
      emit: () => stopped.abort(),
      maximumCycles: 100,
      intervalMs: 1000,
      signal: stopped.signal,
    });
    expect(tick).toHaveBeenCalledTimes(4);
  });
  it('rejects signing flags, unbounded input and mainnet, while defaulting to dry-run', () => {
    expect(schedulerOptions([])).toMatchObject({
      execute: false,
      maximumCycles: 1,
      limits: { concurrency: 1 },
      buyback: null,
    });
    for (const args of [
      ['--signed-file', 'secret'],
      ['--cycles', '0'],
      ['--concurrency', '3'],
      ['--maximum-coins', '101'],
      ['--slippage-bps', '5'],
      ['--max-spend-lamports', '0'],
    ])
      expect(() => schedulerOptions(args)).toThrow();
    expect(
      schedulerOptions(['--max-spend-lamports', '1000', '--slippage-bps', '0']).buyback
        ?.maximumSlippageBps
    ).toBe(0);
    expect(() =>
      assertSchedulerNetwork(NETWORK_GENESIS['mainnet-beta'], NETWORK_GENESIS['mainnet-beta'])
    ).toThrow();
    expect(() => assertSchedulerNetwork('local', 'wrong')).toThrow();
  });
});
