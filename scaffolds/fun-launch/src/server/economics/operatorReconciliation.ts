import { Connection, PublicKey } from '@solana/web3.js';
import { database } from '../database';
import {
  type FinancialStore,
  type EventId,
  type FundingSourceKind,
  type FundingPlan,
} from './financialStore';
import { FinalizedVerifier } from './chainEvidence';
import { type OperatorPlan, failOperatorPlan, completeOperatorPlan } from './operatorStore';
import { verifyFundingReceipt } from './fundingReceipt';
import { verifyDammRealization } from './dammRealization';
import { FinancialDammCheckpointStore } from './checkpointStore';
import { assertCheckpointSigningConfigured } from './dammCheckpoint';
import {
  verifyFinalizedMigrationBinding,
  type MigrationBindingExpectation,
} from '../graduationBinding';

/** Reconcile only the stored signed message against independent finalized chain evidence. Never sends. */
export async function reconcileOperatorExecution(input: {
  rpc: Connection;
  store: FinancialStore;
  genesis: string;
  program: PublicKey;
  plan: OperatorPlan;
  auditFunding?: boolean;
}) {
  const { rpc, store, genesis, program, plan, auditFunding = false } = input,
    id = plan.id,
    verifier = new FinalizedVerifier(rpc, genesis);
  if (plan.network_genesis !== genesis)
    throw new Error('Operator execution belongs to another network');
  if (plan.kind === 'funding') assertCheckpointSigningConfigured();
  if (['finalized', 'failed'].includes(plan.status) && !auditFunding) return plan;
  if (!plan.signature) throw new Error('Operator plan has not been signed');
  const status = (
    await rpc.getSignatureStatuses([plan.signature], { searchTransactionHistory: true })
  ).value[0];
  if (!status || status.confirmationStatus !== 'finalized')
    return { ...plan, awaitingFinality: true };
  if (status.err)
    return failOperatorPlan(id, await verifier.failure(plan.signature, plan.message_digest));
  const evidence = await verifier.transaction(plan.signature, plan.message_digest);
  const metadata = plan.metadata;
  if (plan.kind === 'setup' && metadata.effect === 'bind_migration')
    await verifyFinalizedMigrationBinding(
      evidence,
      program,
      new PublicKey(plan.mint),
      metadata.expected as MigrationBindingExpectation
    );
  if (plan.kind === 'funding') {
    const events = metadata.events as EventId[],
      sourceKind = metadata.sourceKind as FundingSourceKind;
    const funding = await store
      .fundingPlan(genesis, plan.mint, events, sourceKind)
      .catch(async (): Promise<FundingPlan | null> => {
        // The immutable intent may already be finalized in the shadow journal.
        const row = (
          await database().query<{ commitment: string }>(
            `SELECT commitment FROM financial_funding
            WHERE network_genesis=$1 AND signature=$2`,
            [genesis, plan.signature]
          )
        ).rows[0];
        if (row?.commitment === metadata.commitment) return null;
        throw new Error('Funding intent could not be recovered');
      });
    if (funding) {
      const receipt = await verifyFundingReceipt(rpc, evidence, {
        program: program.toBase58(),
        mint: plan.mint,
        fundingId: funding.fundingId,
        commitment: funding.commitment,
        total: funding.lamports,
      });
      await store.recordVerifiedFunding({
        evidence,
        receipt,
        mint: plan.mint,
        vault: String(metadata.vault),
        events,
        sourceKind,
        unwrapAccount: metadata.unwrapAccount as string | undefined,
        sourceQuoteVault: metadata.sourceQuoteVault as string | undefined,
        instruction: {
          accounts: metadata.accounts as string[],
          data: Buffer.from(String(metadata.dataBase64), 'base64'),
          instructionIndex: Number(metadata.instructionIndex),
        },
      });
    }
    const auditable =
      funding ?? (await store.previewFundingPlan(genesis, plan.mint, events, sourceKind, true));
    if (auditable.migrated) {
      const audit = await verifyDammRealization({
        rpc,
        genesis,
        mint: plan.mint,
        pool: auditable.pool,
        rawExpected: auditable.events.reduce((sum, event) => sum + event.net, 0n),
        eventCount: events.length,
        eventIds: events,
        source: 'audit',
        programId: program,
        checkpointStore: new FinancialDammCheckpointStore(),
      });
      if (audit.realizedNet !== auditable.lamports)
        throw new Error('Finalized claim prefix differs from the prepared realized amount');
      await store.recordDammWindowProof(audit);
    }
  } else if (plan.kind === 'epoch') {
    await store.recordVerifiedEpochFunding({
      networkGenesis: genesis,
      mint: plan.mint,
      epoch: Number(metadata.epoch),
      evidence,
      instruction: {
        accounts: metadata.accounts as string[],
        data: Buffer.from(String(metadata.dataBase64), 'base64'),
      },
    });
  }
  return completeOperatorPlan(id, evidence);
}
