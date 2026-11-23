import { expect, it, vi } from 'vitest';
import { Keypair, type Connection } from '@solana/web3.js';
import { vaultAddresses } from '@/lib/vault/client';
import { readVaultEpochs } from './vaultState';

it('verifies a bounded reward page in one finalized bank and rejects a foreign epoch', async () => {
  const program = Keypair.generate().publicKey,
    mint = Keypair.generate().publicKey;
  const { coin } = vaultAddresses(program, mint);
  const data = (epoch: bigint) => {
    const bytes = Buffer.alloc(138);
    bytes.write('REPOCH01');
    bytes[8] = 1;
    coin.toBuffer().copy(bytes, 10);
    bytes.writeBigUInt64LE(epoch, 42);
    bytes.writeBigUInt64LE(100n, 122);
    bytes.writeBigUInt64LE(100n, 130);
    return bytes;
  };
  const fetcher = vi
    .fn()
    .mockResolvedValue([1n, 2n].map((epoch) => ({ owner: program, data: data(epoch) })));
  const rpc = { getMultipleAccountsInfo: fetcher } as unknown as Connection;
  const result = await readVaultEpochs(rpc, program, mint, [1n, 2n]);
  expect(result.size).toBe(2);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[1]).toBe('finalized');
  fetcher.mockResolvedValue([{ owner: program, data: data(9n) }]);
  await expect(readVaultEpochs(rpc, program, mint, [1n])).rejects.toThrow('match');
  await expect(readVaultEpochs(rpc, program, mint, Array(21).fill(1n))).rejects.toThrow('capacity');
});
