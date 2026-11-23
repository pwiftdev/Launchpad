import { PublicKey, SYSVAR_CLOCK_PUBKEY, type Connection } from '@solana/web3.js';

const SYSVAR_OWNER = new PublicKey('Sysvar1111111111111111111111111111111111111');

/** One confirmed account read; no dependency on block-time indexing for the latest slot. */
export async function readDisplayClock(rpc: Pick<Connection, 'getAccountInfo'>): Promise<number> {
  const account = await rpc.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed');
  if (
    !account ||
    account.executable ||
    !account.owner.equals(SYSVAR_OWNER) ||
    account.data.length !== 40
  )
    throw new Error('Display chain clock is unavailable');
  const value = account.data.readBigInt64LE(32);
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Invalid display chain clock');
  return Number(value);
}
