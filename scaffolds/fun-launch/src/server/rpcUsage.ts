const METHODS = new Set([
  'getAccountInfo',
  'getBalance',
  'getBlock',
  'getBlockHeight',
  'getBlockTime',
  'getEpochInfo',
  'getFeeForMessage',
  'getGenesisHash',
  'getLatestBlockhash',
  'getMinimumBalanceForRentExemption',
  'getMultipleAccounts',
  'getProgramAccounts',
  'getRecentPerformanceSamples',
  'getSignatureStatuses',
  'getSignaturesForAddress',
  'getSlot',
  'getTokenAccountBalance',
  'getTokenAccountsByOwner',
  'getTokenLargestAccounts',
  'getTokenSupply',
  'getTransaction',
  'isBlockhashValid',
  'sendTransaction',
  'simulateTransaction',
]);

const counts = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | undefined;

export function recordRpcUsage(
  scope: 'web' | 'mobula',
  body?: unknown
) {
  if (process.env.RPC_USAGE_LOG !== 'true') return;
  let calls: unknown = null;
  if (typeof body === 'string') {
    try {
      calls = JSON.parse(body);
    } catch {
      // Count the request without recording an unrecognized payload.
    }
  }
  for (const call of Array.isArray(calls) && calls.length ? calls : [calls]) {
    const method = (call as { method?: unknown } | null)?.method;
    const label = typeof method === 'string' && METHODS.has(method) ? `${scope}:${method}` : scope;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (timer) return;
  timer = setTimeout(() => {
    console.info(JSON.stringify({ event: 'rpc_usage', calls: Object.fromEntries(counts) }));
    counts.clear();
    timer = undefined;
  }, 60_000);
  timer.unref?.();
}
