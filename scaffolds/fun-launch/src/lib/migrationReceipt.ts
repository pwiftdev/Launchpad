import bs58 from 'bs58';

export type MigrationReceipt = {
  signature: string;
  lastValidBlockHeight?: number;
  preparedSlot?: number;
  savedAt: number;
};
export const migrationReceiptKey = (network: string, mint: string) =>
  `rinsed:migration:v1:${network}:${mint}`;
export function readMigrationReceipt(
  storage: Pick<Storage, 'getItem'>,
  key: string
): MigrationReceipt | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const receipt = JSON.parse(raw) as MigrationReceipt;
    if (
      typeof receipt.signature !== 'string' ||
      bs58.decode(receipt.signature).length !== 64 ||
      !Number.isSafeInteger(receipt.savedAt) ||
      receipt.savedAt < 0 ||
      (receipt.preparedSlot !== undefined &&
        (!Number.isSafeInteger(receipt.preparedSlot) || receipt.preparedSlot < 0)) ||
      (receipt.lastValidBlockHeight !== undefined &&
        (!Number.isSafeInteger(receipt.lastValidBlockHeight) || receipt.lastValidBlockHeight < 0))
    )
      return null;
    return receipt;
  } catch {
    return null;
  }
}
export function writeMigrationReceipt(
  storage: Pick<Storage, 'setItem'>,
  key: string,
  receipt: MigrationReceipt
) {
  storage.setItem(key, JSON.stringify(receipt));
}
