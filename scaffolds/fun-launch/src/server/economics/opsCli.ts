import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import {
  deriveDbcPoolAuthority,
  deriveDammV2PoolAuthority,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { expectedNetworkGenesis, NETWORK_GENESIS } from '../../../../../scripts/network-policy.cjs';
import { database } from '../database';
import { registeredCoin } from '../launchRegistry';
import {
  migrationHistoryBoundary,
  discoverMigrationBoundary,
  recordMigrationTransaction,
} from '../migrationRegistry';
import { vaultAddresses } from '@/lib/vault/client';
import { FinancialStore, type EventId, type FundingSourceKind } from './financialStore';
import { FinalizedVerifier, messageDigest, validateSignedTransaction } from './chainEvidence';
import { FinalizedFeeIndexer } from './finalizedIndexer';
import { MeteoraFinancialAdapter } from './meteoraAdapter';
import { FinancialWorker, assertFinancialRelay } from './financialWorker';
import { collectHolderSnapshot } from './holderSnapshot';
import { reconcileOperatorExecution } from './operatorReconciliation';
import {
  operatorPlan,
  prepareOperatorPlan,
  attachOperatorSignature,
  markOperatorSubmitted,
  markOperatorUncertain,
  refreshUnsignedOperatorPlan,
  recoverCollectedFunding,
} from './operatorStore';
import { verifyOperatorRefresh } from './operatorRecovery';
import { verifyUnsignedBuybackExpiry, verifyUnsignedClaimExpiry } from './claimRecovery';
import { verifyCollectedFundingRecovery } from './fundingRecovery';
import { planFinancialCoin } from './planning';
import { preparePlatformWithdrawal } from './platformWithdrawal';
import { auditFinalizedDammPosition } from './dammRealization';
import { verifyExpiredCommunityClaim } from './claimRenewal';
import { FinancialDammCheckpointStore } from './checkpointStore';
import { assertCheckpointSigningConfigured } from './dammCheckpoint';
import { prepareVaultMigrationBinding } from '../graduationBinding';
import {
  loadExternalSignerCommand,
  requestExternalSignature,
  ExternalSignerError,
} from './externalSigner';

const commands = new Set([
  'status',
  'index',
  'setup',
  'prepare-funding',
  'prepare-buyback',
  'snapshot',
  'prepare-epoch',
  'relay',
  'sign',
  'reconcile',
  'recover-unsigned',
  'record-migration',
  'recover-collected',
  'plan',
  'prepare-platform',
  'audit-funding',
  'prepare-bind-migration',
  'recover-community-claim',
  'audit-replay',
]);
const flags = new Set([
  '--execute',
  '--mint',
  '--id',
  '--out',
  '--signed-file',
  '--local-sign-fixture',
  '--signer-command',
  '--signer-config',
  '--epoch',
  '--commitment',
  '--max-spend-lamports',
  '--slippage-bps',
  '--pool',
  '--signature',
  '--amount-lamports',
]);
const json = (value: unknown) =>
  JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item), 2);

/** Operator CLI only: no keypair loading, hosted signing service or automatic spending loop. */
export async function runFinancialOps(args = process.argv.slice(2)) {
  const command = args.shift();
  if (!command || command === '--help')
    return console.log(
      `Commands: ${[...commands].join(', ')}. Default is a dry run. Add --execute to write journal/unsigned plans; sign/relay require an external signed file, absolute --signer-command, private --signer-config JSON or verified local VM signer and FINANCIAL_WORKER_ENABLED=true. Sign only persists verified signatures; relay broadcasts separately. Mainnet remains closed.`
    );
  if (!commands.has(command)) throw new Error('Unknown financial operation');
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (!flags.has(key)) throw new Error('Unknown operator option');
    if (options[key] !== undefined) throw new Error('Duplicate operator option');
    if (key === '--execute') {
      options[key] = 'true';
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('Operator option requires a value');
    options[key] = value;
  }
  const signingSources = [
    '--signed-file',
    '--local-sign-fixture',
    '--signer-command',
    '--signer-config',
  ].filter((key) => options[key] !== undefined);
  if (signingSources.length > 1 || (signingSources.length && !['relay', 'sign'].includes(command)))
    throw new ExternalSignerError('SIGNER_CONFIGURATION_INVALID');
  const execute = options['--execute'] === 'true',
    genesis = expectedNetworkGenesis(process.env);
  if (!process.env.RPC_URL || !process.env.VAULT_PROGRAM_ID)
    throw new Error('Private RPC and reviewed vault program settings are required');
  const rpc = new Connection(process.env.RPC_URL, {
    commitment: 'finalized',
    disableRetryOnRateLimit: true,
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15000) }),
  });
  if ((await rpc.getGenesisHash()) !== genesis)
    throw new Error('Operator network genesis mismatch');
  const program = new PublicKey(process.env.VAULT_PROGRAM_ID),
    mint = options['--mint'] ? new PublicKey(options['--mint']) : null;
  if (!execute)
    return console.log(
      json({
        dryRun: true,
        command,
        networkGenesis: genesis,
        mint: mint?.toBase58() ?? null,
        transactionsSigned: false,
        transactionsSent: false,
        note: 'Add --execute to persist journal/unsigned plans. Signing and relay are separate explicit actions.',
      })
    );
  const store = new FinancialStore(),
    verifier = new FinalizedVerifier(rpc, genesis),
    worker = new FinancialWorker(rpc, store, genesis);
  if (
    ['plan', 'prepare-funding', 'recover-collected', 'audit-funding', 'audit-replay'].includes(
      command
    )
  )
    assertCheckpointSigningConfigured();
  const emit = (value: unknown) => {
    const output = options['--out'];
    if (output) {
      const target = path.resolve(output),
        privateRoot = path.resolve('.local') + path.sep;
      if (!target.startsWith(privateRoot))
        throw new Error('Operator exports must remain in the private .local directory');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, json(value) + '\n', { mode: 0o600 });
      console.log(json({ written: output, command }));
    } else
      console.log(
        JSON.stringify(
          value,
          (key, item) =>
            key === 'transaction_base64' ||
            key === 'transactionBase64' ||
            key === 'signedTransactionBase64'
              ? '[withheld; export the private plan with --out]'
              : typeof item === 'bigint'
                ? item.toString()
                : item,
          2
        )
      );
  };
  try {
    if (command === 'status') {
      const rows = (
        await database().query(
          `SELECT id,mint,kind,status,signature FROM financial_operator_plans
        WHERE network_genesis=$1 ORDER BY created_at DESC LIMIT 100`,
          [genesis]
        )
      ).rows;
      return emit({
        networkGenesis: genesis,
        operatorPlans: rows,
        balances: mint ? await store.balances(genesis, mint.toBase58()) : undefined,
      });
    }
    if (
      command === 'relay' ||
      command === 'sign' ||
      command === 'reconcile' ||
      command === 'recover-unsigned' ||
      command === 'recover-collected' ||
      command === 'audit-funding' ||
      command === 'recover-community-claim'
    ) {
      const id = options['--id'];
      if (!id) throw new Error('A durable plan/job ID is required');
      const plan = await operatorPlan(id),
        job = plan ? null : await store.job(id);
      if (!plan && !job) throw new Error('Execution does not exist');
      const execution = plan ?? job!;
      if (plan?.kind === 'funding') assertCheckpointSigningConfigured();
      if (execution.network_genesis !== genesis)
        throw new Error('Execution belongs to another network');
      if (command === 'recover-community-claim') {
        if (!job) throw new Error('A signed Community claim job is required');
        return emit(
          await store.renewExpiredCommunityClaim(
            id,
            await verifyExpiredCommunityClaim(rpc, job, program.toBase58())
          )
        );
      }
      if (command === 'recover-collected') {
        if (!plan || !process.env.VAULT_OPERATOR_PUBLIC_KEY)
          throw new Error('Signed funding plan and external operator required');
        return emit(
          await recoverCollectedFunding(
            await verifyCollectedFundingRecovery({
              rpc,
              store,
              plan,
              program,
              operator: new PublicKey(process.env.VAULT_OPERATOR_PUBLIC_KEY),
            })
          )
        );
      }
      if (command === 'recover-unsigned') {
        if (plan)
          return emit(
            await refreshUnsignedOperatorPlan(
              await verifyOperatorRefresh(rpc, plan, program.toBase58())
            )
          );
        if (job!.kind !== 'buyback')
          return emit(
            await store.cancelUnsignedClaim(
              id,
              await verifyUnsignedClaimExpiry(rpc, job!, program.toBase58())
            )
          );
        return emit(
          await store.cancelUnsignedBuyback(
            id,
            await verifyUnsignedBuybackExpiry(rpc, job!, program.toBase58())
          )
        );
      }
      if (command === 'relay' || command === 'sign') {
        await assertFinancialRelay(rpc, genesis);
        if (['finalized', 'failed'].includes(execution.status)) return emit(execution);
        let signed: string;
        if (execution.signature) {
          if (
            validateSignedTransaction(execution.transaction_base64, execution.message_digest)
              .signature !== execution.signature
          )
            throw new ExternalSignerError('SIGNER_RESPONSE_INVALID');
          signed = execution.transaction_base64;
        } else if (options['--signer-command'] || options['--signer-config']) {
          const payer =
            job?.kind === 'platform_claim'
              ? process.env.VAULT_TREASURY_PUBLIC_KEY
              : process.env.VAULT_OPERATOR_PUBLIC_KEY;
          if (
            !payer ||
            (!plan && job!.kind !== 'buyback' && job!.kind !== 'platform_claim') ||
            (job?.kind === 'platform_claim' && job.recipient !== payer)
          )
            throw new ExternalSignerError('SIGNER_REQUEST_INVALID');
          const controller = new AbortController(),
            stop = () => controller.abort();
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
          try {
            const result = await requestExternalSignature({
              command: loadExternalSignerCommand({
                command: options['--signer-command'],
                configFile: options['--signer-config'],
              }),
              rpc,
              signal: controller.signal,
              execution: {
                networkGenesis: genesis,
                vaultProgramId: program.toBase58(),
                executionId: id,
                executionKind: plan?.kind ?? (job!.kind as 'buyback' | 'platform_claim'),
                mint: execution.mint,
                messageDigest: execution.message_digest,
                transactionBase64: execution.transaction_base64,
                lastValidBlockHeight: Number(execution.last_valid_block_height),
                feePayer: new PublicKey(payer).toBase58(),
                requiredSigners: [new PublicKey(payer).toBase58()],
              },
            });
            signed = result.signedTransactionBase64;
          } finally {
            process.removeListener('SIGINT', stop);
            process.removeListener('SIGTERM', stop);
          }
        } else if (options['--local-sign-fixture']) {
          const require = createRequire(path.resolve('scaffolds/fun-launch/package.json'));
          const { createLocalSender } = require(path.resolve('scripts/local-vm-sender.cjs'));
          const sender = await createLocalSender({ fixturePath: options['--local-sign-fixture'] });
          const result = await sender.sign(
            Transaction.from(Buffer.from(execution.transaction_base64, 'base64')),
            { roles: [job?.kind === 'platform_claim' ? 'treasury' : 'operator'] }
          );
          signed = result.signedTransactionBase64;
        } else {
          const file = options['--signed-file'];
          if (!file || fs.statSync(file).size > 24000)
            throw new Error('Provide a bounded external signed transaction file');
          const value = JSON.parse(fs.readFileSync(file, 'utf8')) as {
            signedTransactionBase64?: string;
          };
          if (!value.signedTransactionBase64) throw new Error('Signed transaction file is invalid');
          signed = value.signedTransactionBase64;
        }
        await assertFinancialRelay(rpc, genesis);
        if (job) {
          if (command === 'sign') return emit(await store.attachSignedTransaction(id, signed));
          return emit(await worker.submitSigned(id, signed));
        }
        const attached = await attachOperatorSignature(id, signed);
        if (command === 'sign') return emit(attached);
        const bytes = validateSignedTransaction(
          attached.transaction_base64,
          attached.message_digest
        ).bytes;
        await markOperatorSubmitted(id);
        try {
          await assertFinancialRelay(rpc, genesis);
          const signature = await rpc.sendRawTransaction(bytes, {
            skipPreflight: false,
            maxRetries: 2,
          });
          if (signature !== attached.signature)
            throw new Error('Operator relay returned another signature');
        } catch (error) {
          await markOperatorUncertain(id);
          throw error;
        }
        return emit({ id, signature: attached.signature, status: 'submitted' });
      }
      if (job) return emit(await worker.reconcile(id));
      return emit(
        await reconcileOperatorExecution({
          rpc,
          store,
          genesis,
          program,
          plan: plan!,
          auditFunding: command === 'audit-funding',
        })
      );
    }
    if (!mint) throw new Error('A registered mint is required');
    const coin = await registeredCoin(genesis, mint.toBase58());
    if (!coin || coin.policy_version !== 'rinse-v1')
      throw new Error('Reviewed registered coin is required');
    if (command === 'record-migration') {
      const signature = options['--signature'];
      if (!signature) throw new Error('Finalized migration signature required');
      return emit(await recordMigrationTransaction(genesis, mint.toBase58(), signature));
    }
    const operatorValue = process.env.VAULT_OPERATOR_PUBLIC_KEY;
    if (!operatorValue) throw new Error('External operator public key is required');
    if (command === 'prepare-bind-migration') {
      const prepared = await prepareVaultMigrationBinding({
        rpc,
        networkGenesis: genesis,
        programId: program,
        mint,
        operator: new PublicKey(operatorValue),
      });
      if (prepared.status === 'already-bound') return emit(prepared);
      return emit(
        await prepareOperatorPlan({
          networkGenesis: genesis,
          mint: mint.toBase58(),
          kind: 'setup',
          intentKey: prepared.intentKey,
          transactionBase64: prepared.transactionBase64,
          lastValidBlockHeight: prepared.lastValidBlockHeight,
          metadata: { effect: 'bind_migration', expected: prepared.expected },
        })
      );
    }
    if (command === 'plan') {
      if (genesis === NETWORK_GENESIS['mainnet-beta'])
        throw new Error('Financial planning remains closed on mainnet');
      return emit(
        await planFinancialCoin({
          rpc,
          store,
          networkGenesis: genesis,
          program,
          operator: new PublicKey(operatorValue),
          mint,
        })
      );
    }
    if (command === 'prepare-platform') {
      const pending = (
        await database().query(
          `SELECT id FROM financial_jobs WHERE network_genesis=$1 AND mint=$2
        AND kind='platform_claim' AND status IN ('prepared','signed','submitted','manual_review') LIMIT 1`,
          [genesis, mint.toBase58()]
        )
      ).rows[0];
      if (pending) return emit(await store.job(pending.id));
      const amount = options['--amount-lamports'];
      if (!amount || !/^\d+$/.test(amount))
        throw new Error('Explicit treasury withdrawal amount required');
      return emit(
        await store.prepareExecution(
          await preparePlatformWithdrawal({
            rpc,
            store,
            programId: program,
            mint,
            networkGenesis: genesis,
            amount: BigInt(amount),
            clock: await verifier.clock(),
          })
        )
      );
    }
    const adapter = new MeteoraFinancialAdapter(
      rpc,
      store,
      program,
      new PublicKey(operatorValue),
      genesis
    );
    if (command === 'audit-replay') {
      const state = await adapter.state(mint);
      if (state.migratedPool.equals(PublicKey.default))
        throw new Error('Native migration binding is required before replay audit');
      const result = await auditFinalizedDammPosition({
        rpc,
        genesis,
        mint: mint.toBase58(),
        pool: state.migratedPool.toBase58(),
        programId: program,
        checkpointStore: new FinancialDammCheckpointStore(),
      });
      return emit({
        mint: mint.toBase58(),
        pool: state.migratedPool.toBase58(),
        restoredCheckpoint: result.restoredCheckpoint?.digest ?? null,
        suffixTransactions: result.traced.transactions,
        rawPoolFees: result.replay.raw.toString(),
        ownedRealizedLifetime: (result.replay.claimed + result.replay.pending).toString(),
        transactionsSigned: false,
        transactionsSent: false,
      });
    }
    if (command === 'index') {
      const source = {
        networkGenesis: genesis,
        mint: mint.toBase58(),
        pool: coin.dbc_pool,
        configKey: coin.config_key,
        activationPoint: Number(coin.activation_point),
        mode: coin.mode,
        creatorShareBps: coin.creator_share_bps,
      };
      const indexer = new FinalizedFeeIndexer(rpc, store),
        dbc = await indexer.runPool(source, {
          creationSignature: coin.creation_signature,
          route: 'dbc',
        });
      const state = await adapter.state(mint);
      let damm: unknown = null;
      if (!state.migratedPool.equals(PublicKey.default)) {
        let boundary = await migrationHistoryBoundary(genesis, mint.toBase58());
        if (!boundary) {
          await discoverMigrationBoundary(genesis, mint.toBase58());
          boundary = await migrationHistoryBoundary(genesis, mint.toBase58());
        }
        damm = await indexer.runPool(
          { ...source, pool: state.migratedPool.toBase58() },
          { creationSignature: boundary?.signature ?? null, route: 'damm-v2' }
        );
      }
      return emit({ dbc, damm });
    }
    if (command === 'snapshot') {
      const addresses = vaultAddresses(program, mint);
      const snapshot = await collectHolderSnapshot(rpc, {
        networkGenesis: genesis,
        mint: mint.toBase58(),
        excludedOwners: new Set([
          addresses.coin.toBase58(),
          addresses.feeAuthority.toBase58(),
          deriveDbcPoolAuthority().toBase58(),
          deriveDammV2PoolAuthority().toBase58(),
          PublicKey.default.toBase58(),
        ]),
      });
      const epoch = Math.floor(snapshot.blockTime / 3600) - 1;
      return emit({
        epoch,
        snapshotSlot: snapshot.slot,
        ...(await store.createRewardEpoch({
          networkGenesis: genesis,
          mint: mint.toBase58(),
          epoch,
          snapshot,
        })),
      });
    }
    if (command === 'prepare-buyback') {
      const max = options['--max-spend-lamports'];
      if (!max || !/^\d+$/.test(max)) throw new Error('Explicit maximum buyback spend is required');
      return emit(
        await worker.prepareBuyback(mint.toBase58(), adapter, {
          maximumSpendLamports: BigInt(max),
          maximumSlippageBps: Number(options['--slippage-bps'] ?? 100),
          maximumQuoteAgeSeconds: 15,
          maximumQuoteAgeSlots: 32,
        })
      );
    }
    if (command === 'setup') {
      const prepared = await adapter.setupAccounts(mint);
      return emit(
        await prepareOperatorPlan({
          networkGenesis: genesis,
          mint: mint.toBase58(),
          kind: 'setup',
          intentKey: `setup:${mint}:${messageDigest(Buffer.from(prepared.transactionBase64, 'base64'))}`,
          ...prepared,
          metadata: {},
        })
      );
    }
    if (command === 'prepare-epoch') {
      const epoch = Number(options['--epoch']);
      if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('Epoch is required');
      const prepared = await adapter.prepareEpoch(mint, epoch);
      return emit(
        await prepareOperatorPlan({
          networkGenesis: genesis,
          mint: mint.toBase58(),
          kind: 'epoch',
          intentKey: `epoch:${mint}:${epoch}`,
          transactionBase64: prepared.transactionBase64,
          lastValidBlockHeight: prepared.lastValidBlockHeight,
          metadata: {
            epoch,
            accounts: prepared.instruction.keys.map((key) => key.pubkey.toBase58()),
            dataBase64: prepared.instruction.data.toString('base64'),
          },
        })
      );
    }
    const commitment = options['--commitment'];
    let events: EventId[];
    let sourceKind: FundingSourceKind | undefined;
    if (commitment) {
      const plan = (
        await database().query<{ source_kind: FundingSourceKind }>(
          `SELECT source_kind FROM financial_funding_plans
        WHERE network_genesis=$1 AND mint=$2 AND commitment=$3`,
          [genesis, mint.toBase58(), commitment]
        )
      ).rows[0];
      if (!plan) throw new Error('Funding commitment does not exist');
      sourceKind = plan.source_kind;
      const rows = (
        await database().query<{
          signature: string;
          instruction_index: number;
          event_index: number;
        }>(
          `SELECT signature,instruction_index,event_index
        FROM financial_planned_fee_events WHERE network_genesis=$1 AND mint=$2 AND commitment=$3`,
          [genesis, mint.toBase58(), commitment]
        )
      ).rows;
      events = rows.map((row) => ({
        signature: row.signature,
        instructionIndex: row.instruction_index,
        eventIndex: row.event_index,
      }));
    } else {
      const selectedPool = options['--pool'] ? new PublicKey(options['--pool']).toBase58() : null;
      const candidates = (await store.unfundedEvents(genesis, mint.toBase58())).filter(
          (event) => !selectedPool || event.pool === selectedPool
        ),
        first = candidates[0];
      if (!first)
        throw new Error(
          'No unreserved executed fees; resume an existing commitment or index more history'
        );
      const selected = candidates.filter((event) => event.pool === first.pool);
      const state = await adapter.state(mint);
      if (state.unallocatedCollected > 0n && first.pool === state.migratedPool.toBase58()) {
        sourceKind = 'collected_allocation';
      }
      events = selected.map((event) => event.id);
    }
    const prepared = await adapter.prepareFunding(mint, events, sourceKind);
    if ('normalizedZero' in prepared) return emit(prepared);
    return emit(
      await prepareOperatorPlan({
        networkGenesis: genesis,
        mint: mint.toBase58(),
        kind: 'funding',
        intentKey: `funding:${prepared.plan.commitment}`,
        transactionBase64: prepared.transactionBase64,
        lastValidBlockHeight: prepared.lastValidBlockHeight,
        metadata: {
          events,
          sourceKind: prepared.plan.sourceKind,
          commitment: prepared.plan.commitment,
          vault: prepared.vault,
          unwrapAccount: 'unwrapAccount' in prepared ? prepared.unwrapAccount : undefined,
          sourceQuoteVault: 'sourceQuoteVault' in prepared ? prepared.sourceQuoteVault : undefined,
          accounts: prepared.instruction.keys.map((key) => key.pubkey.toBase58()),
          dataBase64: prepared.instruction.data.toString('base64'),
          instructionIndex: 0,
        },
      })
    );
  } finally {
    await database().end();
  }
}
