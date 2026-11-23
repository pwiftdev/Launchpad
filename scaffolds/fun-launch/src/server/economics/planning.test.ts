import { describe, it, expect, vi } from 'vitest';
import { planHourlyRewards } from './planning';

describe('bounded hourly unsigned planning', () => {
  it('uses the real just-closed hour once, and reuses immutable drafts without another holder scan', async () => {
    let exists = false;
    const deps = {
      clock: async () => ({ blockTime: 7204 }),
      existing: async () => exists,
      capture: vi.fn(async () => {
        exists = true;
      }),
      prepare: vi.fn(async () => {}),
    };
    expect(await planHourlyRewards(deps)).toEqual({ epoch: 1, status: 'prepared' });
    expect(await planHourlyRewards(deps)).toEqual({ epoch: 1, status: 'existing' });
    expect(deps.capture).toHaveBeenCalledExactlyOnceWith(1);
    expect(deps.prepare).toHaveBeenCalledTimes(2);
  });
  it('never backdates a missed window or prepares a root after an incomplete snapshot', async () => {
    const deps = {
      clock: async () => ({ blockTime: 7260 }),
      existing: async () => false,
      capture: vi.fn(async () => {
        throw new Error('incomplete snapshot');
      }),
      prepare: vi.fn(async () => {}),
    };
    expect(await planHourlyRewards(deps)).toEqual({ epoch: 1, status: 'outside_boundary' });
    expect(deps.capture).not.toHaveBeenCalled();
    expect(deps.prepare).not.toHaveBeenCalled();
    deps.clock = async () => ({ blockTime: 7201 });
    await expect(planHourlyRewards(deps)).rejects.toThrow('incomplete');
    expect(deps.prepare).not.toHaveBeenCalled();
  });
});
