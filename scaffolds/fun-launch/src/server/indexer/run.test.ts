import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { DisplayStore } from './store';

const mock = vi.hoisted(() => ({
  connect: vi.fn(),
  genesis: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('../database', () => ({ database: () => ({ connect: mock.connect }) }));
vi.mock('../dbc', () => ({
  networkGenesis: mock.genesis,
  connection: {},
  freshCoins: vi.fn(),
  freshCoin: vi.fn(),
}));
vi.mock('../holderDisplay', () => ({ holderExclusions: vi.fn() }));
vi.mock('./indexer', () => ({
  DisplayIndexer: class {
    constructor(private deps: { store: DisplayStore }) {}
    start = () => mock.start(this.deps.store);
    stop = mock.stop;
  },
}));
import { startDisplayIndexer } from './run';

class Client extends EventEmitter {
  query = vi.fn(async () => ({ rows: [{ ok: true }] }));
  release = vi.fn();
}

describe('display indexer leadership', () => {
  it('retries startup and fences writes from an interrupted leader before takeover', async () => {
    vi.useFakeTimers();
    vi.stubEnv('DATABASE_URL', 'postgresql://fixture.invalid');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const old = new Client();
      const next = new Client();
      let finishScan!: () => void;
      let oldWrite!: Promise<unknown>;
      const scan = new Promise<void>((resolve) => {
        finishScan = resolve;
      });
      mock.genesis.mockResolvedValue('genesis').mockRejectedValueOnce(new Error('RPC startup'));
      mock.connect
        .mockRejectedValueOnce(new Error('database startup'))
        .mockResolvedValueOnce(old)
        .mockResolvedValueOnce(next);
      mock.start
        .mockImplementationOnce((store: DisplayStore) => {
          oldWrite = scan.then(() => store.removeCoinsExcept([]));
          return oldWrite;
        })
        .mockImplementationOnce((store: DisplayStore) => store.removeCoinsExcept([]));
      mock.stop.mockResolvedValue(undefined);

      void startDisplayIndexer();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(mock.connect).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(30_001);
      expect(mock.start).toHaveBeenCalledOnce();
      old.emit('error', new Error('database session vanished'));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(old.release).toHaveBeenCalledWith(true);
      expect(mock.stop).toHaveBeenCalledOnce();
      expect(mock.start).toHaveBeenCalledTimes(2);
      finishScan();
      await expect(oldWrite).rejects.toThrow('lease lost');
      expect(old.query.mock.calls.flat().join(' ')).not.toContain('DELETE FROM display_coins');
      expect(next.query.mock.calls.flat().join(' ')).toContain('DELETE FROM display_coins');
      next.emit('end');
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });
});
