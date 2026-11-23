import bondPolicy from '@/constants/bondPolicy.json';
import type { Coin } from './coin';
import { SCHEDULE, feeModeByPolicy, pct } from './feeModes';

/** Show the configured schedule, never infer the current slot from wall-clock time. */
export function bondFeeDisplay(coin: Pick<Coin, 'feePolicyVersion' | 'isMigrated'>) {
  const mode = feeModeByPolicy(coin.feePolicyVersion);
  if (mode)
    return {
      label: `${pct(SCHEDULE.endingFeeBps)} · ${mode.label}`,
      title: `Flat ${pct(SCHEDULE.endingFeeBps)} before and after bonding (${pct(SCHEDULE.startingFeeBps)} in the launch slot only). Check the live quote before signing.`,
    };
  if (coin.feePolicyVersion !== 'bond-v1') return null;
  return coin.isMigrated
    ? {
        label: `${bondPolicy.migrationFeeBps / 100}%`,
        title: 'Trading fee after bonding. Check the live quote before signing.',
      }
    : {
        label: `${bondPolicy.endingFeeBps / 100}% curve`,
        title: `Normal curve fee. The launch slot charges ${bondPolicy.startingFeeBps / 100}%, except the creator's first buy bundled with creation. Check the live quote for the current fee.`,
      };
}
