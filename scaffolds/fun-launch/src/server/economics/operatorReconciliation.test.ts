import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import type { FinancialStore } from './financialStore';
import type { OperatorPlan } from './operatorStore';
const proofs = vi.hoisted(() => ({
  transaction: vi.fn(),
  failure: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  bind: vi.fn(),
}));
vi.mock('./operatorStore', () => ({
  completeOperatorPlan: proofs.complete,
  failOperatorPlan: proofs.fail,
}));
vi.mock('./chainEvidence', () => ({
  FinalizedVerifier: class {
    transaction = proofs.transaction;
    failure = proofs.failure;
  },
}));
vi.mock('../graduationBinding', () => ({ verifyFinalizedMigrationBinding: proofs.bind }));
import { reconcileOperatorExecution } from './operatorReconciliation';
const plan: OperatorPlan = {
  id: 'saved',
  network_genesis: 'genesis',
  mint: PublicKey.default.toBase58(),
  kind: 'setup',
  intent_key: 'setup',
  transaction_base64: 'signed-exact-bytes',
  message_digest: 'exact-digest',
  last_valid_block_height: '1',
  metadata: { effect: 'bind_migration', expected: { pool: 'canonical' } },
  status: 'submitted',
  signature: 'saved-signature',
  finalized_slot: null,
};
beforeEach(() => vi.clearAllMocks());
function input(status: unknown) {
  return {
    rpc: {
      getSignatureStatuses: vi.fn(async () => ({ value: [status] })),
      sendRawTransaction: vi.fn(),
    } as unknown as Connection,
    store: {} as FinancialStore,
    genesis: 'genesis',
    program: PublicKey.default,
    plan,
  };
}
describe('shared finalized operator reconciliation', () => {
  it('keeps unknown or merely confirmed signatures untouched without sending or rebuilding a message', async () => {
    for (const status of [null, { confirmationStatus: 'confirmed', err: null as null }]) {
      const args = input(status),
        result = await reconcileOperatorExecution(args);
      expect(result).toMatchObject({
        signature: 'saved-signature',
        message_digest: 'exact-digest',
        status: 'submitted',
        awaitingFinality: true,
      });
      expect(args.rpc.sendRawTransaction).not.toHaveBeenCalled();
    }
    expect(proofs.transaction).not.toHaveBeenCalled();
    expect(proofs.complete).not.toHaveBeenCalled();
    expect(proofs.fail).not.toHaveBeenCalled();
  });
  it('verifies the exact saved message and canonical migration effect before completing, idempotently after a restart', async () => {
    const args = input({ confirmationStatus: 'finalized', err: null as null }),
      evidence = { signature: 'saved-signature', messageDigest: 'exact-digest' };
    proofs.transaction.mockResolvedValue(evidence);
    proofs.complete.mockResolvedValue({ ...plan, status: 'finalized' });
    expect((await reconcileOperatorExecution(args)).status).toBe('finalized');
    expect(proofs.transaction).toHaveBeenCalledExactlyOnceWith('saved-signature', 'exact-digest');
    expect(proofs.bind).toHaveBeenCalledExactlyOnceWith(
      evidence,
      PublicKey.default,
      PublicKey.default,
      plan.metadata.expected
    );
    expect(proofs.complete).toHaveBeenCalledExactlyOnceWith('saved', evidence);
    await reconcileOperatorExecution({ ...args, plan: { ...plan, status: 'finalized' } });
    expect(proofs.complete).toHaveBeenCalledTimes(1);
    expect(args.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('requires independent finalized failure proof and preserves submitted work when verification fails', async () => {
    const args = input({
        confirmationStatus: 'finalized',
        err: { InstructionError: [0, 'Custom'] },
      }),
      proof = { signature: 'saved-signature' };
    proofs.failure.mockResolvedValue(proof);
    proofs.fail.mockResolvedValue({ ...plan, status: 'failed' });
    expect((await reconcileOperatorExecution(args)).status).toBe('failed');
    expect(proofs.fail).toHaveBeenCalledExactlyOnceWith('saved', proof);
    const success = input({ confirmationStatus: 'finalized', err: null as null });
    proofs.transaction.mockRejectedValue(new Error('unavailable archival receipt'));
    await expect(reconcileOperatorExecution(success)).rejects.toThrow('archival');
    expect(proofs.complete).not.toHaveBeenCalled();
    expect(success.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
});
