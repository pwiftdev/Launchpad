import { describe, expect, it, vi } from 'vitest';
import { LiveHub } from './live';

const MINT = 'So11111111111111111111111111111111111111112';
const OTHER = '11111111111111111111111111111111';

function hub(capacity = 10) {
  let lost: () => void = () => {};
  const end = vi.fn(async () => {});
  const connect = vi.fn(async (_: (payload: string) => void, onLost: () => void) => {
    lost = onLost;
    return { end };
  });
  return { live: new LiveHub(connect, capacity), connect, end, lose: () => lost() };
}

describe('live hub', () => {
  it('shares one database listener and routes each event to its coin and the board', async () => {
    const { live, connect } = hub();
    const coin = vi.fn(),
      other = vi.fn(),
      board = vi.fn();
    await live.subscribe(MINT, coin);
    await live.subscribe(OTHER, other);
    await live.subscribe('board', board);
    expect(connect).toHaveBeenCalledTimes(1);
    live.dispatch(`trades:${MINT}`);
    expect(coin).toHaveBeenCalledWith({ kind: 'trades', mint: MINT });
    expect(other).not.toHaveBeenCalled();
    expect(board).toHaveBeenCalledTimes(1);
    live.dispatch('not-an-event');
    expect(board).toHaveBeenCalledTimes(1);
  });

  it('caps open streams, frees a slot on release and survives a failing listener', async () => {
    const { live } = hub(2);
    const release = await live.subscribe(MINT, () => {
      throw new Error('closed socket');
    });
    const healthy = vi.fn();
    await live.subscribe(MINT, healthy);
    await expect(live.subscribe(MINT, vi.fn())).rejects.toThrow('capacity');
    live.dispatch(`coin:${MINT}`);
    expect(healthy).toHaveBeenCalled();
    release();
    release();
    expect(live.size).toBe(1);
    await live.subscribe(MINT, vi.fn());
  });

  it('tells every stream to refresh when the listener drops, then reconnects', async () => {
    vi.useFakeTimers();
    try {
      const { live, connect, end, lose } = hub();
      const board = vi.fn();
      await live.subscribe('board', board);
      lose();
      expect(end).toHaveBeenCalled();
      expect(board).toHaveBeenCalledWith({ kind: 'board' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(connect).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
