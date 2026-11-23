import bs58 from 'bs58';

export type TradeReceipt = {
  signature: string;
  genesis: string;
  lastValidBlockHeight: number;
  preparedSlot: number;
};
export const tradeReceiptKey = (network: string, mint: string, wallet: string) =>
  `rinsed:trade:v1:${network}:${mint}:${wallet}`;
export function readTradeReceipt(
  storage: Pick<Storage, 'getItem'>,
  key: string
): TradeReceipt | null {
  const value = storage.getItem(key);
  if (!value) return null;
  const receipt = JSON.parse(value) as TradeReceipt;
  if (
    typeof receipt.signature !== 'string' ||
    bs58.decode(receipt.signature).length !== 64 ||
    typeof receipt.genesis !== 'string' ||
    bs58.decode(receipt.genesis).length !== 32 ||
    !Number.isSafeInteger(receipt.lastValidBlockHeight) ||
    receipt.lastValidBlockHeight < 0 ||
    !Number.isSafeInteger(receipt.preparedSlot) ||
    receipt.preparedSlot < 0
  )
    throw new Error('Saved trade receipt is invalid. Check wallet history before trading again.');
  return receipt;
}
