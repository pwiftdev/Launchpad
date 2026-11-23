import type { Connection, PublicKey } from '@solana/web3.js';

export class WalletRecipientUnavailable extends Error {
  override readonly name = 'WalletRecipientUnavailable';
  constructor() {
    super('Accrue more rewards or fund your wallet before requesting this payout.');
  }
}
/** Ordinary SOL credit must satisfy the recipient account's actual minimum balance. */
export async function assertWalletRecipientCredit(
  rpc: Pick<Connection, 'getAccountInfo' | 'getMinimumBalanceForRentExemption'>,
  recipient: PublicKey,
  amount: bigint
) {
  if (amount <= 0n || amount > 18446744073709551615n) throw new Error('Invalid payout credit');
  const account = await rpc.getAccountInfo(recipient, 'finalized');
  if (account?.executable) throw new Error('Executable accounts cannot receive wallet rewards');
  const balance = account?.lamports ?? 0;
  const minimum = await rpc.getMinimumBalanceForRentExemption(
    account?.data.length ?? 0,
    'finalized'
  );
  if (
    !Number.isSafeInteger(balance) ||
    balance < 0 ||
    !Number.isSafeInteger(minimum) ||
    minimum < 0
  )
    throw new Error('Recipient account minimum balance is unavailable');
  if (BigInt(balance) + amount < BigInt(minimum)) throw new WalletRecipientUnavailable();
}
