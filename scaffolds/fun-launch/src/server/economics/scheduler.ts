export type SchedulerReceipt = { id: string; kind: 'operator' | 'job' };
export type SchedulerLease = {
  alive(): boolean;
  signal?: AbortSignal;
  progress(mint: string, processed: number, failed: number): Promise<void>;
  finish(
    status: 'completed' | 'stopped' | 'failed',
    processed: number,
    failed: number
  ): Promise<void>;
  release(): Promise<void>;
};
export type SchedulerDependencies = {
  acquire(): Promise<SchedulerLease | null>;
  discover(limit: number): Promise<string[]>;
  pending(mint: string, limit: number): Promise<{ receipts: SchedulerReceipt[]; more: boolean }>;
  reconcile(receipt: SchedulerReceipt): Promise<'finalized' | 'failed' | 'pending'>;
  plan(mint: string): Promise<'planned' | 'pending'>;
};
export type SchedulerLimits = {
  maximumCoins: number;
  maximumReceiptsPerCoin: number;
  concurrency: number;
};
export type SchedulerResult = {
  status: 'busy' | 'completed' | 'stopped' | 'failed';
  processed: number;
  failed: number;
  planned: number;
  pending: number;
  coins: Array<{ mint: string; status: 'planned' | 'pending' | 'failed' }>;
  transactionsSigned: false;
  transactionsSent: false;
};
export function schedulerLimits(limits: SchedulerLimits) {
  for (const [value, max] of [
    [limits.maximumCoins, 100],
    [limits.maximumReceiptsPerCoin, 100],
    [limits.concurrency, 2],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new Error('Invalid unsigned scheduler limits');
  return limits;
}
/** Finite, restart-safe orchestration. Its dependency surface deliberately has no signer or relay. */
export async function runSchedulerTick(
  deps: SchedulerDependencies,
  input: SchedulerLimits,
  signal?: AbortSignal
): Promise<SchedulerResult> {
  const limits = schedulerLimits(input),
    result: SchedulerResult = {
      status: 'busy',
      processed: 0,
      failed: 0,
      planned: 0,
      pending: 0,
      coins: [],
      transactionsSigned: false,
      transactionsSent: false,
    };
  if (signal?.aborted) return { ...result, status: 'stopped' };
  const lease = await deps.acquire();
  if (!lease) return result;
  const running = () => !signal?.aborted && lease.alive();
  try {
    result.status = 'completed';
    const mints = await deps.discover(limits.maximumCoins);
    if (mints.length > limits.maximumCoins || new Set(mints).size !== mints.length)
      throw new Error('Invalid scheduler discovery response');
    for (let offset = 0; offset < mints.length && running(); offset += limits.concurrency) {
      const batch = mints.slice(offset, offset + limits.concurrency);
      await Promise.all(
        batch.map(async (mint) => {
          let status: 'planned' | 'pending' | 'failed' = 'failed';
          try {
            const saved = await deps.pending(mint, limits.maximumReceiptsPerCoin);
            if (saved.receipts.length > limits.maximumReceiptsPerCoin)
              throw new Error('Receipt capacity exceeded');
            let pending = saved.more;
            for (const receipt of saved.receipts) {
              if (!running()) {
                pending = true;
                break;
              }
              if ((await deps.reconcile(receipt)) === 'pending') pending = true;
            }
            if (!running() || pending) {
              status = 'pending';
              result.pending++;
            } else {
              status = await deps.plan(mint);
              if (status === 'planned') result.planned++;
              else result.pending++;
            }
          } catch {
            // Provider/SQL errors may contain credentials or response bodies. Emit only fixed status.
            result.failed++;
          }
          result.processed++;
          result.coins.push({ mint, status });
        })
      );
      // Advance only a batch that was actually attempted. A crash repeats at most this bounded batch.
      if (lease.alive())
        await lease.progress(batch[batch.length - 1]!, result.processed, result.failed);
    }
    if (!running()) result.status = 'stopped';
    if (lease.alive()) await lease.finish(result.status, result.processed, result.failed);
    return result;
  } catch {
    result.status = 'failed';
    if (lease.alive())
      await lease.finish('failed', result.processed, result.failed).catch(() => {});
    return result;
  } finally {
    await lease.release();
  }
}

/** Sequential ticks: interval never overlaps work, and signals stop new work without cancelling settlement. */
export async function runSchedulerLoop(input: {
  tick: () => Promise<SchedulerResult>;
  intervalMs: number;
  maximumCycles: number;
  signal: AbortSignal;
  emit: (result: SchedulerResult) => void;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  if (
    !Number.isSafeInteger(input.intervalMs) ||
    input.intervalMs < 1000 ||
    input.intervalMs > 3_600_000 ||
    !Number.isSafeInteger(input.maximumCycles) ||
    input.maximumCycles < 1 ||
    input.maximumCycles > 1_000_000
  )
    throw new Error('Invalid scheduler loop bounds');
  const wait =
    input.wait ??
    ((ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', finish);
            resolve();
          },
          timer = setTimeout(finish, ms);
        signal.addEventListener('abort', finish, { once: true });
      }));
  for (let cycle = 0; cycle < input.maximumCycles && !input.signal.aborted; cycle++) {
    input.emit(await input.tick());
    if (cycle + 1 < input.maximumCycles && !input.signal.aborted)
      await wait(input.intervalMs, input.signal);
  }
}
