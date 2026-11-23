import {
  BASE_FEE_PERCENT,
  LAUNCH_TAX_CLIFF_PERCENT,
  LAUNCH_TAX_PERIODS,
  LAUNCH_TAX_REDUCTION_BPS,
  LAUNCH_TAX_STEP_SECONDS,
} from '@/constants/launch';
import type { Coin } from './coin';
import bondPolicy from '@/constants/bondPolicy.json';

/** The launch-slot guard is based on slots, never a guessed seconds countdown. */
export function bondFeePercentAtSlot(
  launchSlot: number,
  currentSlot: number,
  graduated = false,
  bundledCreatorBuy = false
) {
  if (
    !Number.isSafeInteger(launchSlot) ||
    launchSlot < 0 ||
    !Number.isSafeInteger(currentSlot) ||
    currentSlot < launchSlot
  )
    throw new Error('A valid launch slot and current slot are required');
  if (graduated) return bondPolicy.migrationFeeBps / 100;
  if (bundledCreatorBuy) return bondPolicy.endingFeeBps / 100;
  return (
    (currentSlot < launchSlot + bondPolicy.periodSlots
      ? bondPolicy.startingFeeBps
      : bondPolicy.endingFeeBps) / 100
  );
}
export function hasCurrentTaxSchedule(coin: Pick<Coin, 'isDemo' | 'feePolicyVersion'>) {
  return (
    coin.isDemo === true ||
    coin.feePolicyVersion === 'rinse-v1' ||
    coin.feePolicyVersion === 'wallet-v1'
  );
}

/** Launch tax (in %) charged at a given number of seconds after launch. */
export function taxPercentAt(secondsSinceLaunch: number): number {
  const period = Math.min(
    Math.max(Math.floor(secondsSinceLaunch / LAUNCH_TAX_STEP_SECONDS), 0),
    LAUNCH_TAX_PERIODS
  );
  return LAUNCH_TAX_CLIFF_PERCENT * Math.pow(1 - LAUNCH_TAX_REDUCTION_BPS / 10_000, period);
}

/** The 10 steps of the schedule, t = 0, 3, ... 27 seconds. */
export const TAX_STEPS = Array.from({ length: LAUNCH_TAX_PERIODS + 1 }, (_, i) => ({
  second: i * LAUNCH_TAX_STEP_SECONDS,
  percent: taxPercentAt(i * LAUNCH_TAX_STEP_SECONDS),
}));

export type TaxState = {
  percent: number;
  /** Seconds until the next step down, or null once the tax has reached the floor */
  nextStepIn: number | null;
  isClean: boolean;
};

export function taxStateAt(secondsSinceLaunch: number, graduated = false): TaxState {
  if (graduated) return { percent: BASE_FEE_PERCENT, nextStepIn: null, isClean: true };
  const percent = taxPercentAt(secondsSinceLaunch);
  const period = Math.floor(secondsSinceLaunch / LAUNCH_TAX_STEP_SECONDS);
  if (period >= LAUNCH_TAX_PERIODS) {
    return { percent, nextStepIn: null, isClean: true };
  }
  const nextStepIn = (period + 1) * LAUNCH_TAX_STEP_SECONDS - secondsSinceLaunch;
  return { percent, nextStepIn: Math.max(nextStepIn, 0), isClean: false };
}

export const formatTaxPercent = (percent: number) =>
  percent <= BASE_FEE_PERCENT + 0.01
    ? '1.25%'
    : `${percent < 10 ? percent.toFixed(1) : percent.toFixed(0)}%`;
