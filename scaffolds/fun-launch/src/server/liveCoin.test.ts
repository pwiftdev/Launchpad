import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair, type Connection } from '@solana/web3.js';
import { CoinLiveHub } from './liveCoin';
afterEach(() => vi.useRealTimers());
function fixture(maxClients = 3, maxCoins = 2) {
  const callbacks = new Map<number, Parameters<Connection['onLogs']>[1]>(),
    remove = vi.fn(async () => {}),
    onLogs = vi.fn((_key: unknown, callback: Parameters<Connection['onLogs']>[1]) => {
      const id = callbacks.size + 1;
      callbacks.set(id, callback);
      return id;
    }),
    invalidate = vi.fn(),
    hub = new CoinLiveHub(
      { onLogs, removeOnLogsListener: remove } as unknown as Connection,
      invalidate,
      maxClients,
      maxCoins
    );
  return { hub, callbacks, remove, onLogs, invalidate };
}
describe('bounded display-only live updates', () => {
  it('shares canonical pool subscriptions, coalesces logs and removes every subscription after last viewer', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      pool = Keypair.generate().publicKey.toBase58(),
      a = vi.fn(),
      b = vi.fn(),
      stopA = f.hub.subscribe('mint', [pool], a),
      stopB = f.hub.subscribe('mint', [pool], b);
    expect(f.onLogs).toHaveBeenCalledTimes(1);
    const callback = f.callbacks.get(1)!;
    callback({ signature: 'first', err: null, logs: [] }, { slot: 100 });
    callback({ signature: 'last', err: null, logs: [] }, { slot: 101 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledWith({ signature: 'last', slot: 101 });
    expect(f.invalidate).toHaveBeenCalledWith('mint', [pool]);
    stopA();
    expect(f.remove).not.toHaveBeenCalled();
    stopB();
    stopB();
    expect(f.remove).toHaveBeenCalledExactlyOnceWith(1);
  });
  it('rejects excess clients and clears pending timers on disconnect', async () => {
    vi.useFakeTimers();
    const f = fixture(1, 1),
      pool = Keypair.generate().publicKey.toBase58(),
      sink = vi.fn(),
      stop = f.hub.subscribe('mint', [pool], sink);
    expect(() => f.hub.subscribe('other', [pool], sink)).toThrow('capacity');
    f.callbacks.get(1)!(
      { signature: 'ignored', err: { InstructionError: [0, 'failed'] }, logs: [] },
      { slot: 1 }
    );
    f.callbacks.get(1)!({ signature: 'later', err: null, logs: [] }, { slot: 2 });
    stop();
    await vi.advanceTimersByTimeAsync(1500);
    expect(sink).not.toHaveBeenCalled();
    expect(f.remove).toHaveBeenCalledOnce();
  });
  it('a broken listener does not prevent another user from receiving an invalidation hint', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      pool = Keypair.generate().publicKey.toBase58(),
      sink = vi.fn(),
      a = f.hub.subscribe('mint', [pool], () => {
        throw Error('closed');
      }),
      b = f.hub.subscribe('mint', [pool], sink);
    f.callbacks.get(1)!({ signature: 'transaction', err: null, logs: [] }, { slot: 3 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sink).toHaveBeenCalledOnce();
    a();
    b();
  });
});
