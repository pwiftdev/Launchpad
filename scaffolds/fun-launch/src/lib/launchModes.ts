import bondPolicy from '@/constants/bondPolicy.json';

/** Historical modes remain readable; only Bond it. is admitted for new launches. */
export type LaunchMode = 'bond' | 'creator' | 'community';
export type LaunchPolicyVersion = 'bond-v1' | 'wallet-v1' | 'rinse-v1' | 'legacy-devnet';
export const ACTIVE_LAUNCH_MODE = 'bond' as const;
export const ACTIVE_LAUNCH_POLICY = bondPolicy.version as 'bond-v1';
export const isWalletPolicy = (policy: string) => policy === 'bond-v1' || policy === 'wallet-v1';
export const hasCreatorRewards = (mode: LaunchMode) => mode === 'bond' || mode === 'creator';
