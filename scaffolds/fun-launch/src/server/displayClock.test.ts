import { expect, it, vi } from 'vitest';
import { PublicKey, SYSVAR_CLOCK_PUBKEY, type Connection } from '@solana/web3.js';
import { readDisplayClock } from './displayClock';
const owner = new PublicKey('Sysvar1111111111111111111111111111111111111');
function fixture(timestamp = 1_790_000_000n) {
  const data = Buffer.alloc(40);
  data.writeBigInt64LE(timestamp, 32);
  const account = { owner, data, executable: false, lamports: 1 };
  const getAccountInfo = vi.fn(async () => account);
  return {
    account,
    getAccountInfo,
    rpc: { getAccountInfo } as unknown as Pick<Connection, 'getAccountInfo'>,
  };
}
it('reads observed time in one confirmed sysvar request without a latest-block lookup', async () => {
  const f = fixture();
  expect(await readDisplayClock(f.rpc)).toBe(1_790_000_000);
  expect(f.getAccountInfo).toHaveBeenCalledExactlyOnceWith(SYSVAR_CLOCK_PUBKEY, 'confirmed');
});
it('rejects malformed clocks without substituting the host clock', async () => {
  for (const value of [0n, -1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n])
    await expect(readDisplayClock(fixture(value).rpc)).rejects.toThrow();
  const f = fixture();
  f.account.owner = PublicKey.default;
  await expect(readDisplayClock(f.rpc)).rejects.toThrow();
  f.account.owner = owner;
  f.account.data = Buffer.alloc(32);
  await expect(readDisplayClock(f.rpc)).rejects.toThrow();
});
