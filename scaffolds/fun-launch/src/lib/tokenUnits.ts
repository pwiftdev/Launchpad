/** Exact decimal display for on-chain integer quantities, including values above Number's limit. */
export function formatTokenUnits(value: string | bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18)
    throw new Error('Invalid decimals');
  const units = BigInt(value);
  if (units < 0n) throw new Error('Negative token quantity');
  const scale = 10n ** BigInt(decimals);
  const whole = (units / scale).toLocaleString('en-US');
  const fraction = decimals
    ? (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
    : '';
  return fraction ? `${whole}.${fraction}` : whole;
}
export const formatSol = (lamports: string | bigint) => `${formatTokenUnits(lamports, 9)} SOL`;
