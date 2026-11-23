import { expect, it } from 'vitest';
import { formatSol, formatTokenUnits } from './tokenUnits';
it('keeps one-lamport differences visible beyond the safe Number range', () => {
  expect(formatSol('9007199254740993')).toBe('9,007,199.254740993 SOL');
  expect(formatSol('1')).toBe('0.000000001 SOL');
  expect(formatSol('1000000000')).toBe('1 SOL');
  expect(formatTokenUnits('18446744073709551615', 6)).toBe('18,446,744,073,709.551615');
  expect(formatTokenUnits('1000', 0)).toBe('1,000');
});
