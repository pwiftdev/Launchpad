import { afterEach, expect, it, vi } from 'vitest';
import { recordRpcUsage } from './rpcUsage';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('logs separate counters per method in a batch without logging parameters', () => {
  vi.useFakeTimers();
  vi.stubEnv('RPC_USAGE_LOG', 'true');
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const transaction = { method: 'getTransaction', params: ['private-signature'] };
  recordRpcUsage('web', JSON.stringify([transaction, transaction]));
  recordRpcUsage('rings', JSON.stringify({ method: 'private-unrecognized-method' }));
  recordRpcUsage('rings-proof');
  expect(info).not.toHaveBeenCalled();
  vi.advanceTimersByTime(60_000);
  expect(info).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({
      event: 'rpc_usage',
      calls: { 'web:getTransaction': 2, rings: 1, 'rings-proof': 1 },
    })
  );
});
