import { Connection, PublicKey } from '@solana/web3.js';
import { expectedNetworkGenesis } from '../../../../../scripts/network-policy.cjs';
import { configuredCompanyWallets } from '../launchConfig';
import { database } from '../database';
import { WalletStore } from './walletStore';
import { WalletWorker, WalletMessageExpired } from './walletWorker';
import { WalletSchedulerStore } from './walletSchedulerStore';
import { MeteoraWalletAdapter } from './walletAdapter';
import { WalletExternalSigner } from './walletSigner';
import { loadExternalSignerCommand } from './externalSigner';
import { assertWalletExecutionGate } from './walletGate';
import type { SchedulerLease } from './scheduler';
const commands = new Set([
  'status',
  'index',
  'plan',
  'reconcile',
  'sign',
  'relay',
  'recover',
  'run',
  'prepare-platform',
]);
const booleans = new Set(['--execute', '--automatic']);
const flags = new Set([
  ...booleans,
  '--mint',
  '--id',
  '--cycles',
  '--interval-ms',
  '--maximum-coins',
  '--maximum-jobs',
  '--max-spend-lamports',
  '--slippage-bps',
  '--signer-command',
  '--signer-config',
]);
const json = (value: unknown) =>
  JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
export function walletCliOptions(argv: string[]) {
  const args = [...argv],
    command = args.shift() ?? 'run';
  if (command === '--help') return { command, options: {} as Record<string, string> };
  if (!commands.has(command)) throw new Error('Unknown wallet operation');
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (!flags.has(key) || options[key] !== undefined) throw new Error('Invalid wallet option');
    if (booleans.has(key)) {
      options[key] = 'true';
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('Wallet option needs value');
    options[key] = value;
  }
  return { command, options };
}
const bounded = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error('Invalid bounded worker limit');
  return parsed;
};
export async function runWalletCli(argv = process.argv.slice(2)) {
  const { command, options } = walletCliOptions(argv);
  if (command === '--help') {
    console.log(
      'Wallet operations: status, index, plan, reconcile, sign, relay, recover, prepare-platform, run. Default is read-only dry run. --execute writes durable unsigned plans. prepare-platform requires --mint and --max-spend-lamports. --automatic additionally enables explicitly gated external signing and relay. No private keys are loaded here.'
    );
    return;
  }
  const cycles = bounded(options['--cycles'], 1, 1, 10000),
    interval = bounded(options['--interval-ms'], 15000, 1000, 3600000),
    maximumCoins = bounded(options['--maximum-coins'], 20, 1, 100),
    maximumJobs = bounded(options['--maximum-jobs'], 20, 1, 100),
    slippage = bounded(options['--slippage-bps'], 100, 1, 100);
  const maxSpend =
    options['--max-spend-lamports'] === undefined
      ? undefined
      : BigInt(options['--max-spend-lamports']);
  if (maxSpend !== undefined && (maxSpend <= 0n || maxSpend > 18446744073709551615n))
    throw new Error('Invalid buyback limit');
  if (
    (options['--automatic'] && command !== 'run') ||
    (options['--signer-config'] && options['--signer-command']) ||
    ((options['--signer-config'] || options['--signer-command']) &&
      command !== 'sign' &&
      options['--automatic'] !== 'true') ||
    (['sign', 'relay', 'recover'].includes(command) && !options['--id']) ||
    (command === 'prepare-platform' && (!options['--mint'] || maxSpend === undefined)) ||
    (options['--id'] && options['--mint'])
  )
    throw new Error('Invalid signer options');
  const genesis = expectedNetworkGenesis(process.env);
  if (!process.env.RPC_URL) throw new Error('Private RPC URL required');
  const controller = new AbortController();
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    controller.abort();
    shutdownTimer ??= setTimeout(() => {
      process.exitCode = 1;
      process.exit(1);
    }, 30000);
    shutdownTimer.unref();
  };
  const rpc = new Connection(process.env.RPC_URL, {
    commitment: 'finalized',
    disableRetryOnRateLimit: true,
    fetch: (url, init) =>
      fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      }),
  });
  if ((await rpc.getGenesisHash()) !== genesis) throw new Error('Wallet RPC genesis mismatch');
  const wallets = configuredCompanyWallets(genesis, { allowLegacy: true });
  if (options['--mint']) new PublicKey(options['--mint']);
  if (options['--execute'] !== 'true') {
    console.log(
      json({
        command,
        dryRun: true,
        networkGenesis: genesis,
        transactionsSigned: false,
        transactionsSent: false,
      })
    );
    return;
  }
  const mutating = command !== 'status';
  if (mutating) await assertWalletExecutionGate(rpc, genesis, { worker: true });
  const store = new WalletStore(),
    saved = new WalletSchedulerStore(genesis, wallets.collector.toBase58());
  const signing = options['--automatic'] === 'true' || command === 'sign';
  const signer = signing
    ? new WalletExternalSigner(
        rpc,
        genesis,
        loadExternalSignerCommand({
          command: options['--signer-command'],
          configFile: options['--signer-config'],
        })
      )
    : undefined;
  let activeLease: SchedulerLease | null = null;
  const runtimeGate = async () => {
    if (controller.signal.aborted || !activeLease?.alive())
      throw new Error('Private worker lease lost or shutdown requested');
    return assertWalletExecutionGate(rpc, genesis, { worker: true });
  };
  const worker = new WalletWorker(
    rpc,
    store,
    genesis,
    wallets.collector,
    new MeteoraWalletAdapter(rpc, genesis, wallets.collector, slippage),
    runtimeGate,
    signer
  );
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    if (command === 'status') {
      console.log(json(await store.health(genesis, wallets.collector.toBase58())));
      return;
    }
    for (
      let cycle = 0;
      cycle < (command === 'run' ? cycles : 1) && !controller.signal.aborted;
      cycle++
    ) {
      const lease = await saved.acquire();
      if (!lease) {
        console.log(json({ status: 'busy', transactionsSigned: false, transactionsSent: false }));
        break;
      }
      activeLease = lease;
      let processed = 0,
        failed = 0,
        signed = 0,
        sent = 0;
      const rows: Array<{ mint: string; status: string }> = [];
      try {
        const mints = options['--mint']
          ? [options['--mint']]
          : options['--id']
            ? [(await worker.required(options['--id'])).mint]
            : await saved.discover(maximumCoins);
        for (const mint of mints) {
          if (controller.signal.aborted || !lease.alive()) break;
          try {
            if (command === 'index') await worker.index(mint);
            else if (command === 'prepare-platform') {
              await runtimeGate();
              const job = await store.queueBudget({
                networkGenesis: genesis,
                mint,
                kind: 'platform_claim',
                maximumLamports: maxSpend!,
              });
              if (job) await worker.prepare(job.id);
            } else if (command === 'sign') {
              if (!options['--id']) throw new Error('Job id required');
              await worker.sign(options['--id']);
              signed++;
            } else if (command === 'relay') {
              if (!options['--id']) throw new Error('Job id required');
              await worker.relay(options['--id']);
              sent++;
            } else if (command === 'recover') {
              if (!options['--id']) throw new Error('Job id required');
              await worker.recover(options['--id']);
            } else {
              const pending = await store.pendingJobs(genesis, mint, maximumJobs);
              for (const job of pending) {
                if (controller.signal.aborted || !lease.alive()) break;
                if (job.signature) await worker.reconcile(job.id);
              }
              if (command !== 'reconcile') {
                await worker.plan(mint, maxSpend, maximumJobs, options['--automatic'] === 'true');
                if (options['--automatic'] === 'true')
                  for (const job of await store.pendingJobs(genesis, mint, maximumJobs)) {
                    if (controller.signal.aborted || !lease.alive()) break;
                    try {
                      const current = await worker.required(job.id);
                      if (current.status === 'prepared') {
                        await worker.sign(job.id);
                        signed++;
                      }
                      if (
                        ['prepared', 'signed', 'submitted', 'manual_review'].includes(
                          current.status
                        )
                      ) {
                        await worker.relay(job.id);
                        sent++;
                      }
                    } catch (error) {
                      if (!(error instanceof WalletMessageExpired)) throw error;
                      const renewed = await worker.recover(job.id);
                      if (renewed.status === 'queued') await worker.prepare(job.id);
                    }
                  }
              }
            }
            rows.push({ mint, status: 'completed' });
          } catch {
            failed++;
            rows.push({ mint, status: 'failed' });
          }
          processed++;
          await lease.progress(mint, processed, failed);
        }
        await lease.finish(controller.signal.aborted ? 'stopped' : 'completed', processed, failed);
      } catch (error) {
        await lease.finish('failed', processed, failed);
        throw error;
      } finally {
        await lease.release();
        activeLease = null;
      }
      console.log(
        json({
          status: controller.signal.aborted ? 'stopped' : 'completed',
          processed,
          failed,
          coins: rows,
          transactionsSigned: signed,
          transactionsSent: sent,
          unsignedOnly: options['--automatic'] !== 'true' && !['sign', 'relay'].includes(command),
        })
      );
      if (cycle + 1 < cycles && !controller.signal.aborted)
        await new Promise<void>((resolve) => {
          const done = () => {
              clearTimeout(timer);
              controller.signal.removeEventListener('abort', done);
              resolve();
            },
            timer = setTimeout(done, interval);
          controller.signal.addEventListener('abort', done, { once: true });
        });
    }
  } finally {
    if (shutdownTimer) clearTimeout(shutdownTimer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await database().end();
  }
}
