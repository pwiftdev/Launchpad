import { describe, expect, it } from 'vitest';
import { DAMM_PROOF_LIMITS, DammProofBudget, DammProofCapacityError } from './dammProofCapacity';

describe('bounded DAMM replay work', () => {
  it('keeps the real small fixed-point rehearsal within the supported limits', () => {
    const budget = new DammProofBudget(() => 0);
    expect(() => {
      budget.transactions(20);
      budget.events(60);
    }).not.toThrow();
  });

  it('reports event capacity separately from an economic LP policy rejection', () => {
    const budget = new DammProofBudget(() => 0);
    try {
      budget.events(DAMM_PROOF_LIMITS.events + 1);
      throw new Error('Expected the proof capacity guard');
    } catch (error) {
      expect(error).toBeInstanceOf(DammProofCapacityError);
      expect(error).toMatchObject({
        code: 'DAMM_PROOF_CAPACITY_LIMIT',
        capacity: 'events',
      });
      expect(String(error)).toContain('do not skip history');
    }
  });

  it('bounds fetched transactions, decoded events and a monotonic overall deadline', () => {
    let now = 1000;
    const budget = new DammProofBudget(() => now);
    expect(() => budget.transactions(DAMM_PROOF_LIMITS.transactions + 1)).toThrow(
      DammProofCapacityError
    );
    expect(() => budget.events(DAMM_PROOF_LIMITS.events + 1)).toThrow(DammProofCapacityError);
    now += DAMM_PROOF_LIMITS.elapsedMilliseconds + 1;
    expect(() => budget.time()).toThrow(DammProofCapacityError);
  });
  it('counts archived witness work cumulatively regardless of whether it runs before or after the suffix', () => {
    const before = new DammProofBudget(() => 0);
    before.additionalTransactions(2);
    expect(() => before.transactions(DAMM_PROOF_LIMITS.transactions - 1)).toThrow(
      DammProofCapacityError
    );
    const after = new DammProofBudget(() => 0);
    after.events(DAMM_PROOF_LIMITS.events - 1);
    expect(() => after.additionalEvents(2)).toThrow(DammProofCapacityError);
    expect(() => after.events(0)).toThrow(DammProofCapacityError);
  });
});
