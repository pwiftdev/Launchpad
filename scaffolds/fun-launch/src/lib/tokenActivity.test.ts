import { describe, expect, it } from 'vitest';
import type { Trade } from './coin';
import { displayShare, holderSupplyShare, rankTraders } from './tokenActivity';

const trade = (patch: Partial<Trade>): Trade => ({
  sig: 'receipt',
  ts: 100,
  side: 'buy',
  wallet: 'alice',
  sol: 1,
  tokens: 10,
  feeSol: 0.01,
  priceSol: 0.1,
  marketCapSol: 100,
  ...patch,
});

describe('token activity display', () => {
  it('deduplicates swaps while retaining separate invocations in one transaction', () => {
    const a = trade({ id: 'receipt:0:0' });
    const b = trade({ id: 'receipt:1:0', side: 'sell', sol: 2, feeSol: 0.02 });
    const [ranked] = rankTraders([a, a, b]);
    expect(ranked).toMatchObject({ buys: 1, sells: 1, boughtSol: 1, soldSol: 2, volumeSol: 3.02 });
  });
  it('ranks actual observed volume without treating sales as profit', () => {
    const ranked = rankTraders([
      trade({}),
      trade({ sig: 'second', wallet: 'bob', sol: 4 }),
      trade({ sig: 'broken', sol: NaN }),
      trade({ sig: 'badfee', feeSol: Infinity }),
    ]);
    expect(ranked.map((r) => r.wallet)).toEqual(['bob', 'alice']);
    expect(ranked[0]).not.toHaveProperty('profit');
  });
  it('uses total supply rather than the outside-pool denominator and preserves tiny stakes', () => {
    const holder = { owner: 'alice', amount: 10, isCreator: false, shareOfCirculating: 1 };
    expect(holderSupplyShare(holder, 1000)).toBe(0.01);
    expect(holderSupplyShare(holder, undefined)).toBeNull();
    expect(displayShare(0.0000001)).toBe('<0.01%');
    expect(displayShare(0)).toBe('0.00%');
    expect(displayShare(null)).toBe('—');
  });
});
