import type BN from 'bn.js';

export type ReviewedSwap = { pool: string; minimumAmountOut: BN };

export class TradeQuoteChanged extends Error {
  constructor() {
    super('The quote changed. Review the updated trade before signing.');
  }
}

export function assertReviewedSwap(reviewed: ReviewedSwap, pool: string, amountOut: BN) {
  if (reviewed.pool !== pool || amountOut.lt(reviewed.minimumAmountOut))
    throw new TradeQuoteChanged();
}
