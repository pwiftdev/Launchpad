import bondPolicy from '@/constants/bondPolicy.json';

import {
  isFeeModeId,
  isModePolicyVersion,
  feeMode,
  type FeeModeId,
  type ModePolicyVersion,
} from './feeModes';
export type LaunchMode = 'bond' | 'creator' | 'community' | FeeModeId;
export type LaunchPolicyVersion =
  'bond-v1' | 'wallet-v1' | 'rinse-v1' | 'legacy-devnet' | ModePolicyVersion;
export const ACTIVE_LAUNCH_MODE = 'bond' as const;
export const ACTIVE_LAUNCH_POLICY = bondPolicy.version as 'bond-v1';
export const isWalletPolicy = (policy: string) =>
  policy === 'bond-v1' || policy === 'wallet-v1' || isModePolicyVersion(policy);
export const usesLaunchSlot = (mode: LaunchMode) => mode === 'bond' || isFeeModeId(mode);
export const hasCreatorRewards = (mode: LaunchMode) =>
  mode === 'bond' ||
  mode === 'creator' ||
  (isFeeModeId(mode) && feeMode(mode).beneficiary === 'creator');
export const isMskdMode = (mode: LaunchMode): mode is 'mskd' | 'mskd-hsol' =>
  mode === 'mskd' || mode === 'mskd-hsol';
export const isCashbackMode = (mode: LaunchMode): mode is 'cashback' | 'cashback-hsol' =>
  mode === 'cashback' || mode === 'cashback-hsol';
export const hasBatchedHolderRewards = (mode: LaunchMode) =>
  isCashbackMode(mode) || isMskdMode(mode);
/** Masked: one launch type whose creator and holders share 0.60%, paid through the company collector. */
export const isMaskedMode = (mode: LaunchMode): mode is 'masked' => mode === 'masked';
/** Coins whose fees the company collector claims and pays out, rather than the creator directly. */
export const paysThroughCollector = (mode: LaunchMode) =>
  mode === 'community' || hasBatchedHolderRewards(mode) || isMaskedMode(mode);
