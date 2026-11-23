/* Integer-only acceptance evidence for isolated DAMM rehearsals. */
function compareDammExecution(prepared, executed) {
  const integer = (value) => {
    if (!/^(0|[1-9][0-9]*)$/.test(String(value)))
      throw new Error('Invalid unsigned comparison amount');
    return BigInt(value);
  };
  if (!['buy', 'sell'].includes(prepared.side)) throw new Error('Unknown comparison side');
  for (const name of ['amountIn', 'amountOut', 'totalFee']) {
    if (integer(prepared[name]) !== integer(executed[name]))
      throw new Error(`DAMM integer quote/execution mismatch: ${name}`);
  }
  if (integer(executed.amountOut) < integer(prepared.minimumOut))
    throw new Error('Executed output below prepared minimum');
  const baseDelta = BigInt(executed.baseDelta),
    nativeDelta = BigInt(executed.nativeDelta);
  const expectedBase =
    prepared.side === 'buy' ? integer(executed.amountOut) : -integer(executed.amountIn);
  const expectedNative =
    prepared.side === 'buy' ? -integer(executed.amountIn) : integer(executed.amountOut);
  // Caller proves pre-existing base ATA and absent WSOL ATA: wrapping rent nets to zero.
  if (baseDelta !== expectedBase || nativeDelta + integer(executed.networkFee) !== expectedNative)
    throw new Error('Executed event does not match trader account deltas');
  return {
    outputDifference: '0',
    feeDifference: '0',
    inputDifference: '0',
    accountDeltasMatch: true,
  };
}
module.exports = { compareDammExecution };
