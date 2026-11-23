import { expect, it } from 'vitest';
import { bondFeeDisplay } from './bondFeeDisplay';

it('distinguishes normal curve fees and the launch-slot guard without guessing slot completion', () => {
  const display = bondFeeDisplay({ feePolicyVersion: 'bond-v1', isMigrated: false });
  expect(display?.label).toBe('1.25% curve');
  expect(display?.title).toContain('99%');
  expect(display?.title).toContain('bundled with creation');
});
it('shows the reduced fee after bonding and preserves historical schedules', () => {
  expect(bondFeeDisplay({ feePolicyVersion: 'bond-v1', isMigrated: true })?.label).toBe('1%');
  expect(bondFeeDisplay({ feePolicyVersion: 'wallet-v1', isMigrated: true })).toBeNull();
  expect(bondFeeDisplay({ feePolicyVersion: undefined, isMigrated: false })).toBeNull();
});
