export const TRADE_SLIPPAGE_BPS = 300;

export function minimumTradeOutput(output: string) {
  const units = BigInt(output);
  return ((units * BigInt(10_000 - TRADE_SLIPPAGE_BPS) + 9_999n) / 10_000n).toString();
}
