import bondPolicy from '@/constants/bondPolicy.json';

import { isFeeModeId, isModePolicyVersion, type FeeModeId, type ModePolicyVersion } from './feeModes';
export type LaunchMode = 'bond' | 'creator' | 'community' | FeeModeId;
export type LaunchPolicyVersion = 'bond-v1' | 'wallet-v1' | 'rinse-v1' | 'legacy-devnet' | ModePolicyVersion;
export const ACTIVE_LAUNCH_MODE = 'bond' as const;
export const ACTIVE_LAUNCH_POLICY = bondPolicy.version as 'bond-v1';
export const isWalletPolicy = (policy: string) => policy === 'bond-v1' || policy === 'wallet-v1' || isModePolicyVersion(policy);
export const usesLaunchSlot = (mode: LaunchMode) => mode === 'bond' || isFeeModeId(mode);
export const hasCreatorRewards = (mode: LaunchMode) => mode === 'bond' || mode === 'creator' || mode === 'dev';
