import type { Connection, PublicKey } from '@solana/web3.js';
import { ExternalSignerError } from './externalSigner';
import type { WalletStore } from './walletStore';
import { WalletMessageExpired, type WalletWorker } from './walletWorker';
import type { WalletJob } from './walletTypes';

type ExecutionWorker = Pick<WalletWorker, 'required' | 'sign' | 'relay' | 'recover' | 'prepare'>;

export function walletExecutionIssue(error: unknown) {
  return error instanceof ExternalSignerError ? error.code : 'WALLET_EXECUTION_DEFERRED';
}

export async function walletQueueAlerts(
  store: Pick<WalletStore, 'oldestUserClaimSeconds' | 'custodyRequirement'>,
  rpc: Pick<Connection, 'getBalanceAndContext'>,
  genesis: string,
  collector: PublicKey
) {
  const alerts: string[] = [];
  try {
    const address = collector.toBase58();
    const [claimAge, custody] = await Promise.all([
      store.oldestUserClaimSeconds(genesis, address),
      store.custodyRequirement(genesis, address),
    ]);
    if (claimAge >= 120) alerts.push('WALLET_USER_PAYOUT_WAITING');
    const cash = await rpc.getBalanceAndContext(collector, {
      commitment: 'finalized',
      minContextSlot: custody.minimumSlot,
    });
    if (cash.context.slot < custody.minimumSlot || !Number.isSafeInteger(cash.value))
      throw new Error('Collector balance observation unavailable');
    const headroom = BigInt(cash.value) - custody.liability - custody.operating;
    if (headroom < 0n) alerts.push('WALLET_CUSTODY_SHORTFALL');
    else if (headroom < 10_000_000n) alerts.push('WALLET_COLLECTOR_HEADROOM_LOW');
  } catch {
    alerts.push('WALLET_MONITOR_UNAVAILABLE');
  }
  return alerts;
}

export async function drainWalletExecutionQueue(
  worker: ExecutionWorker,
  candidates: readonly Pick<WalletJob, 'id'>[],
  alive: () => boolean
) {
  let signed = 0;
  let sent = 0;
  const alerts = new Set<string>();
  for (const { id } of candidates) {
    if (!alive()) break;
    let job = await worker.required(id);
    if (job.status === 'finalized' || job.status === 'failed') continue;
    try {
      if (job.status === 'queued') job = await worker.prepare(id);
      if (!job.signature) {
        if (job.status !== 'prepared') continue;
        await worker.sign(id);
        signed++;
      }
      if (!alive()) break;
      if ((await worker.relay(id)).status === 'submitted') {
        sent++;
        break;
      }
    } catch (error) {
      if (!alive()) break;
      if (error instanceof WalletMessageExpired) {
        try {
          const recovered = await worker.recover(id);
          if (recovered.status === 'queued' && alive()) await worker.prepare(id);
        } catch (recoveryError) {
          alerts.add(walletExecutionIssue(recoveryError));
        }
      } else {
        alerts.add(walletExecutionIssue(error));
      }
      const durable = await worker.required(id);
      if (durable.signature && durable.status !== 'finalized' && durable.status !== 'failed') break;
    }
  }
  return { signed, sent, alerts: [...alerts] };
}
