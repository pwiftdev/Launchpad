import { performance } from 'node:perf_hooks';

/** Deliberate operator limits until independently verified persistent replay checkpoints exist. */
export const DAMM_PROOF_LIMITS = Object.freeze({
  transactions: 10_000,
  events: 50_000,
  elapsedMilliseconds: 120_000,
});
type Capacity = keyof typeof DAMM_PROOF_LIMITS;

export class DammProofCapacityError extends Error {
  readonly code = 'DAMM_PROOF_CAPACITY_LIMIT';
  constructor(
    readonly capacity: Capacity,
    readonly observed: number,
    readonly maximum: number
  ) {
    super(
      `DAMM proof capacity reached (${capacity}: ${observed}, limit ${maximum}). ` +
        'No funding proof was issued. Preserve the finalized archive and use a reviewed persistent ' +
        'replay checkpoint or capacity upgrade; do not skip history or treat this as an LP policy failure.'
    );
    this.name = 'DammProofCapacityError';
  }
}

export class DammProofBudget {
  private readonly started: number;
  private transactionBase = 0;
  private transactionAdditional = 0;
  private eventBase = 0;
  private eventAdditional = 0;
  constructor(private readonly clock: () => number = () => performance.now()) {
    this.started = clock();
  }

  private bounded(kind: Capacity, count: number) {
    if (!Number.isFinite(count) || count < 0) throw new Error('Invalid DAMM proof work counter');
    if (count > DAMM_PROOF_LIMITS[kind])
      throw new DammProofCapacityError(kind, count, DAMM_PROOF_LIMITS[kind]);
  }

  time() {
    this.bounded('elapsedMilliseconds', Math.max(0, this.clock() - this.started));
  }

  transactions(count: number) {
    this.time();
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid transaction counter');
    this.transactionBase = Math.max(this.transactionBase, count);
    this.bounded('transactions', this.transactionBase + this.transactionAdditional);
  }

  events(count: number) {
    this.time();
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid event counter');
    this.eventBase = Math.max(this.eventBase, count);
    this.bounded('events', this.eventBase + this.eventAdditional);
  }

  additionalTransactions(count: number) {
    this.time();
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error('Invalid additional transaction counter');
    this.transactionAdditional += count;
    this.bounded('transactions', this.transactionBase + this.transactionAdditional);
  }

  additionalEvents(count: number) {
    this.time();
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error('Invalid additional event counter');
    this.eventAdditional += count;
    this.bounded('events', this.eventBase + this.eventAdditional);
  }
}
