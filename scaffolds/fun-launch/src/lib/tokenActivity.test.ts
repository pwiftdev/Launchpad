import { describe, expect, it } from 'vitest';
import { displayShare, holderSupplyShare } from './tokenActivity';

describe('holder share display', () => {
  it('uses total supply rather than the outside-pool denominator and preserves tiny stakes', () => {
    const holder = { owner: 'alice', amount: 10, isCreator: false, shareOfCirculating: 1 };
    expect(holderSupplyShare(holder, 1000)).toBe(0.01);
    expect(holderSupplyShare(holder, undefined)).toBeNull();
    expect(displayShare(0.0000001)).toBe('<0.01%');
    expect(displayShare(0)).toBe('0.00%');
    expect(displayShare(null)).toBe('—');
  });
});
