import { Connection, PublicKey } from '@solana/web3.js';
import { expectedNetworkGenesis, NETWORK_GENESIS } from '../../../../../scripts/network-policy.cjs';
import { database } from '../database';
import { FinancialStore } from './financialStore';
import { FinancialWorker } from './financialWorker';
import { MeteoraFinancialAdapter } from './meteoraAdapter';
import { operatorPlan } from './operatorStore';
import { reconcileOperatorExecution } from './operatorReconciliation';
import { planFinancialCoin } from './planning';
import { assertCheckpointSigningConfigured } from './dammCheckpoint';
import { runSchedulerLoop, runSchedulerTick, schedulerLimits } from './scheduler';
import { FinancialSchedulerStore } from './schedulerStore';

export function schedulerOptions(args: readonly string[]) {
  const values = new Map<string, string>();
  const flags = new Set([
    '--execute',
    '--cycles',
    '--interval-ms',
    '--maximum-coins',
    '--maximum-receipts',
    '--concurrency',
    '--max-spend-lamports',
    '--slippage-bps',
  ]);
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    if (!flags.has(name) || values.has(name)) throw new Error('Invalid scheduler option');
    if (name === '--execute') {
      values.set(name, 'true');
      continue;
    }
    const value = args[++index];
    if (!value || !/^\d+$/.test(value))
      throw new Error('Bounded numeric scheduler option required');
    values.set(name, value);
  }
  const number = (name: string, fallback: number) => Number(values.get(name) ?? fallback),
    limits = schedulerLimits({
      maximumCoins: number('--maximum-coins', 20),
      maximumReceiptsPerCoin: number('--maximum-receipts', 20),
      concurrency: number('--concurrency', 1),
    }),
    maximumCycles = number('--cycles', 1),
    intervalMs = number('--interval-ms', 15000),
    slippage = number('--slippage-bps', 100),
    max = values.get('--max-spend-lamports');
  if (
    !Number.isSafeInteger(maximumCycles) ||
    maximumCycles < 1 ||
    maximumCycles > 1_000_000 ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1000 ||
    intervalMs > 3_600_000 ||
    !Number.isSafeInteger(slippage) ||
    slippage < 0 ||
    slippage > 100 ||
    (!max && values.has('--slippage-bps')) ||
    (max && (BigInt(max) <= 0n || BigInt(max) > (1n << 64n) - 1n))
  )
    throw new Error('Invalid scheduler bounds');
  return {
    execute: values.has('--execute'),
    limits,
    maximumCycles,
    intervalMs,
    buyback: max
      ? {
          maximumSpendLamports: BigInt(max),
          maximumSlippageBps: slippage,
          maximumQuoteAgeSeconds: 15,
          maximumQuoteAgeSlots: 32,
        }
      : null,
  };
}
export function assertSchedulerNetwork(genesis: string, actual: string) {
  if (genesis === NETWORK_GENESIS['mainnet-beta'] || genesis !== actual)
    throw new Error(
      'Unsigned financial scheduling remains closed on mainnet or a mismatched network'
    );
}

/** CLI/service boundary. No secret-key loading, signing, sendRawTransaction or rebroadcast path. */
export async function runFinancialScheduler(args = process.argv.slice(2)) {
  if (args.includes('--help'))
    return console.log(
      'Unsigned scheduler: default dry-run; --execute persists plans/reconciles receipts; --cycles 1..1000000 --interval-ms 1000..3600000 --maximum-coins 1..100 --maximum-receipts 1..100 --concurrency 1..2. Optional --max-spend-lamports and --slippage-bps prepare bounded unsigned buybacks. Signing and broadcasting always require separate review.'
    );
  const options = schedulerOptions(args),
    genesis = expectedNetworkGenesis(process.env);
  if (
    !process.env.RPC_URL ||
    !process.env.VAULT_PROGRAM_ID ||
    !process.env.VAULT_OPERATOR_PUBLIC_KEY
  )
    throw new Error('Private reviewed scheduler settings required');
  const program = new PublicKey(process.env.VAULT_PROGRAM_ID),
    operator = new PublicKey(process.env.VAULT_OPERATOR_PUBLIC_KEY);
  if (process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID !== program.toBase58())
    throw new Error('Scheduler vault settings disagree');
  let shutdownDeadline: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController(),
    stop = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      shutdownDeadline = setTimeout(() => {
        console.error(
          JSON.stringify({
            code: 'UNSIGNED_SCHEDULER_STOP_TIMEOUT',
            message:
              'Unsigned scheduler exceeded its shutdown grace period; saved work is retried after restart.',
          })
        );
        process.exit(1);
      }, 30000);
      shutdownDeadline.unref();
    },
    rpc = new Connection(process.env.RPC_URL, {
      commitment: 'finalized',
      disableRetryOnRateLimit: true,
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        }),
    });
  assertSchedulerNetwork(genesis, await rpc.getGenesisHash());
  if (!options.execute)
    return console.log(
      JSON.stringify({
        dryRun: true,
        networkGenesis: genesis,
        limits: options.limits,
        maximumCycles: options.maximumCycles,
        intervalMs: options.intervalMs,
        buybackPlanning: options.buyback !== null,
        transactionsSigned: false,
        transactionsSent: false,
      })
    );
  assertCheckpointSigningConfigured();
  const journal = new FinancialStore(),
    saved = new FinancialSchedulerStore(genesis, program.toBase58()),
    worker = new FinancialWorker(rpc, journal, genesis),
    adapter = new MeteoraFinancialAdapter(rpc, journal, program, operator, genesis);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    await runSchedulerLoop({
      maximumCycles: options.maximumCycles,
      intervalMs: options.intervalMs,
      signal: controller.signal,
      emit: (result) => console.log(JSON.stringify(result)),
      tick: () =>
        runSchedulerTick(
          {
            acquire: async () => {
              const lease = await saved.acquire();
              if (!lease) return null;
              lease.signal?.addEventListener('abort', stop, { once: true });
              return {
                ...lease,
                release: async () => {
                  lease.signal?.removeEventListener('abort', stop);
                  await lease.release();
                },
              };
            },
            discover: (limit) => saved.discover(limit),
            pending: (mint, limit) => saved.pending(mint, limit),
            reconcile: async (receipt) => {
              const execution =
                receipt.kind === 'job'
                  ? await worker.reconcile(receipt.id)
                  : await (async () => {
                      const plan = await operatorPlan(receipt.id);
                      if (!plan) throw new Error('Saved operator plan missing');
                      return reconcileOperatorExecution({
                        rpc,
                        store: journal,
                        genesis,
                        program,
                        plan,
                      });
                    })();
              return execution.status === 'finalized'
                ? 'finalized'
                : execution.status === 'failed'
                  ? 'failed'
                  : 'pending';
            },
            plan: async (mint) => {
              const result = await planFinancialCoin({
                rpc,
                store: journal,
                networkGenesis: genesis,
                program,
                operator,
                mint: new PublicKey(mint),
              });
              if (result.status !== 'planned') return 'pending';
              if (options.buyback && !controller.signal.aborted)
                await worker.prepareBuyback(mint, adapter, options.buyback);
              return 'planned';
            },
          },
          options.limits,
          controller.signal
        ),
    });
  } finally {
    if (shutdownDeadline) clearTimeout(shutdownDeadline);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await database().end();
  }
}
