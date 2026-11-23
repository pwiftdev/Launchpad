import { expect, it } from 'vitest';
import bs58 from 'bs58';
import { readTradeReceipt, tradeReceiptKey } from './tradeReceipt';
it('separates network, wallet and mint and refuses an incomplete or malformed saved trade', () => {
  const row = {
    signature: bs58.encode(new Uint8Array(64).fill(1)),
    genesis: bs58.encode(new Uint8Array(32).fill(2)),
    lastValidBlockHeight: 100,
    preparedSlot: 80,
  };
  const storage = { getItem: () => JSON.stringify(row) };
  expect(readTradeReceipt(storage, 'test')).toEqual(row);
  expect(tradeReceiptKey('devnet', 'mint', 'wallet')).not.toBe(
    tradeReceiptKey('mainnet-beta', 'mint', 'wallet')
  );
  expect(tradeReceiptKey('devnet', 'mint', 'wallet')).not.toBe(
    tradeReceiptKey('devnet', 'mint', 'other')
  );
  expect(tradeReceiptKey('devnet', 'mint', 'wallet')).not.toBe(
    tradeReceiptKey('devnet', 'other', 'wallet')
  );
  for (const changed of [
    { ...row, genesis: 'bad' },
    { ...row, preparedSlot: -1 },
    { ...row, lastValidBlockHeight: undefined },
  ])
    expect(() => readTradeReceipt({ getItem: () => JSON.stringify(changed) }, 'test')).toThrow();
});
