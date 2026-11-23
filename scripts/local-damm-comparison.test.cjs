const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareDammExecution } = require('./local-damm-comparison.cjs');
const buy = {
  side: 'buy',
  amountIn: '200000000',
  amountOut: '981234567890',
  totalFee: '2500000',
  minimumOut: '960000000000',
};
const buyReceipt = {
  amountIn: buy.amountIn,
  amountOut: buy.amountOut,
  totalFee: buy.totalFee,
  baseDelta: buy.amountOut,
  nativeDelta: '-200005000',
  networkFee: '5000',
};
test('DAMM buy quote matches integer event and both account deltas', () => {
  assert.equal(compareDammExecution(buy, buyReceipt).accountDeltasMatch, true);
});
test('DAMM sell quote matches output SOL after network fee', () => {
  assert.equal(
    compareDammExecution(
      {
        ...buy,
        side: 'sell',
        amountIn: '500000000000',
        amountOut: '99000000',
        minimumOut: '98000000',
      },
      {
        amountIn: '500000000000',
        amountOut: '99000000',
        totalFee: buy.totalFee,
        baseDelta: '-500000000000',
        nativeDelta: '98995000',
        networkFee: '5000',
      }
    ).outputDifference,
    '0'
  );
});
test('DAMM minimum success alone cannot hide quote, fee or account mismatch', () => {
  for (const field of ['amountIn', 'amountOut', 'totalFee', 'baseDelta', 'nativeDelta'])
    assert.throws(
      () => compareDammExecution(buy, { ...buyReceipt, [field]: '1' }),
      /mismatch|deltas/
    );
  assert.throws(
    () => compareDammExecution({ ...buy, minimumOut: '981234567891' }, buyReceipt),
    /minimum/
  );
  assert.throws(() => compareDammExecution({ ...buy, amountIn: '1.5' }, buyReceipt), /unsigned/);
});
