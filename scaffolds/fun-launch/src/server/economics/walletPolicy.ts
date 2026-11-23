// Company operating policy. Small buyback balances remain funded until they accumulate.
export const MINIMUM_BUYBACK_LAMPORTS = 25_000_000n;
export const TREASURY_INTERVAL_SECONDS = 15 * 60;
export const MAXIMUM_AUTOMATIC_TREASURY_LAMPORTS = 1_000_000_000n;
export class WalletOperatingUnavailable extends Error {
  override readonly name = 'WalletOperatingUnavailable';
  constructor() {
    super('Accrue more operating fees before executing Bond it. jobs');
  }
}

export function treasuryIntent(blockTime: number) {
  if (!Number.isSafeInteger(blockTime) || blockTime < 0)
    throw new Error('Invalid treasury schedule clock');
  return `platform:quarter-hour:${Math.floor(blockTime / TREASURY_INTERVAL_SECONDS)}`;
}
