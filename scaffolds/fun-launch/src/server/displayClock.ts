import { PublicKey, SYSVAR_CLOCK_PUBKEY, type Connection } from '@solana/web3.js';

const SYSVAR_OWNER = new PublicKey('Sysvar1111111111111111111111111111111111111');

/** Read the slot and time from the same confirmed Clock sysvar. */
export async function readDisplayClock(rpc: Pick<Connection, 'getAccountInfo'>) {
  const account = await rpc.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed');
  if (
    !account ||
    account.executable ||
    !account.owner.equals(SYSVAR_OWNER) ||
    account.data.length !== 40
  )
    throw new Error('Display chain clock is unavailable');
  const slot = account.data.readBigUInt64LE(0);
  const chainTime = account.data.readBigInt64LE(32);
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  if (slot > maximum || chainTime <= 0n || chainTime > maximum)
    throw new Error('Invalid display chain clock');
  return { slot: Number(slot), chainTime: Number(chainTime) };
}
