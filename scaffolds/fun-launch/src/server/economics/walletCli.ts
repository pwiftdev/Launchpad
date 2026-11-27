import { Connection, PublicKey } from '@solana/web3.js';
import { expectedNetworkGenesis } from '../../../../../scripts/network-policy.cjs';
import { configuredCompanyWallets } from '../launchConfig';
import { database } from '../database';
import { WalletStore } from './walletStore';
import { WalletWorker } from './walletWorker';
import { WalletSchedulerStore } from './walletSchedulerStore';
import { MeteoraWalletAdapter } from './walletAdapter';
import { WalletExternalSigner } from './walletSigner';
import { loadExternalSignerCommand } from './externalSigner';
import { assertWalletExecutionGate } from './walletGate';
import { mskdBuybackMint } from './maskedBuyback';
import type { SchedulerLease } from './scheduler';
import {
  drainWalletExecutionQueue,
  walletExecutionIssue,
  walletQueueAlerts,
} from './walletExecutionQueue';
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
  'resume-wxmr',
]);
const booleans = new Set(['--execute', '--automatic', '--masked-buyback-only']);
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
      'Wallet operations: status, index, plan, reconcile, sign, relay, recover, prepare-platform, resume-wxmr, run. Default is read-only dry run. --execute writes durable unsigned plans. prepare-platform requires --mint and --max-spend-lamports. resume-wxmr requires --id with the last reviewed failed payment job. --automatic additionally enables explicitly gated external signing and relay. No private keys are loaded here.'
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
    (options['--masked-buyback-only'] &&
      (maxSpend === undefined || (command !== 'run' && command !== 'plan'))) ||
    (options['--signer-config'] && options['--signer-command']) ||
    ((options['--signer-config'] || options['--signer-command']) &&
      command !== 'sign' &&
      options['--automatic'] !== 'true') ||
    (['sign', 'relay', 'recover'].includes(command) && !options['--id']) ||
    (command === 'prepare-platform' && (!options['--mint'] || maxSpend === undefined)) ||
    (command === 'resume-wxmr' &&
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(options['--id'] ?? '')) ||
    (options['--id'] && options['--mint'])
  )
    throw new Error('Invalid signer options');
  const genesis = expectedNetworkGenesis(process.env);
  const buybackMint = options['--masked-buyback-only'] ? mskdBuybackMint(genesis) : undefined;
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
  const automatic = options['--automatic'] === 'true';
  const signing = automatic || command === 'sign';
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
    const lease = activeLease;
    if (controller.signal.aborted || !lease?.alive())
      throw new Error('Private worker lease lost or shutdown requested');
    const wallets = await assertWalletExecutionGate(rpc, genesis, { worker: true });
    if (controller.signal.aborted || activeLease !== lease || !lease.alive())
      throw new Error('Private worker lease lost or shutdown requested');
    return wallets;
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
      const alerts = new Set<string>();
      const healthy = () => !controller.signal.aborted && lease.alive();
      const rows: Array<{ mint: string; status: string }> = [];
      let resumedClaim: string | null | undefined;
      try {
        if ((command === 'run' || command === 'plan') && !options['--mint'] && healthy()) {
          try {
            await worker.queueWxmrPayments();
          } catch {
            alerts.add('WALLET_WXMR_QUEUE_UNAVAILABLE');
          }
        }
        const collector = wallets.collector.toBase58();
        if (command === 'resume-wxmr') {
          await runtimeGate();
          resumedClaim = await store.resumeMaskedWxmrClaim(genesis, collector, options['--id']!);
        }
        const mints =
          command === 'resume-wxmr'
            ? []
            : options['--mint']
              ? [options['--mint']]
              : options['--id']
                ? [(await worker.required(options['--id'])).mint]
                : await saved.discover(maximumCoins);
        const dispatch = async () => {
          const candidates = await store.executionCandidates(
            genesis,
            collector,
            maximumJobs,
            options['--mint'] ?? (options['--id'] ? mints[0] : undefined)
          );
          const execution = await drainWalletExecutionQueue(worker, candidates, healthy);
          signed += execution.signed;
          sent += execution.sent;
          for (const alert of execution.alerts) alerts.add(alert);
          return candidates.length > 0;
        };
        const hadCandidates = automatic && healthy() && (await dispatch());
        for (const mint of mints) {
          if (!healthy()) break;
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
              if (!automatic)
                for (const job of await store.pendingJobs(genesis, mint, maximumJobs)) {
                  if (!healthy()) break;
                  if (job.signature) await worker.reconcile(job.id);
                }
              if (command !== 'reconcile') {
                const buybackLimit =
                  buybackMint === undefined || mint === buybackMint ? maxSpend : undefined;
                await worker.plan(mint, buybackLimit, maximumJobs, automatic);
              }
            }
            rows.push({ mint, status: 'completed' });
          } catch (error) {
            alerts.add(walletExecutionIssue(error));
            failed++;
            rows.push({ mint, status: 'failed' });
          }
          processed++;
          await lease.progress(mint, processed, failed);
        }
        if (automatic && healthy()) {
          if (!hadCandidates) await dispatch();
          if (healthy())
            for (const alert of await walletQueueAlerts(store, rpc, genesis, wallets.collector))
              alerts.add(alert);
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
          alerts: [...alerts],
          resumedClaim,
          unsignedOnly: !automatic && !['sign', 'relay'].includes(command),
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
