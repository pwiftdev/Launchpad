import type { AccountInfo } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import { expect, it, vi } from 'vitest';
import { walletOperatingCosts } from './walletOperatingCosts';

const token = new PublicKey('H1gursXFD2soNxjrmdV9FBzkPgDBdcgS8LxtoetnFGFP');
const quote = new PublicKey('So11111111111111111111111111111111111111112');
const existing = {
  lamports: 2039280,
  owner: token,
  data: Buffer.alloc(165),
  executable: false,
} as AccountInfo<Buffer>;
function rpc(accounts: (AccountInfo<Buffer> | null)[]) {
  return {
    getMultipleAccountsInfo: vi.fn(async () => accounts),
    getMinimumBalanceForRentExemption: vi.fn(async () => 2039280),
  };
}
it('allows the first live-sized collection using earned fees while retaining refunded rent as a cash requirement', async () => {
  const result = await walletOperatingCosts(rpc([null, null]), 'collect', 10000n, token, quote);
  expect(result).toEqual({ operatingCostLamports: 2049280n, temporaryFundingLamports: 2039280n });
  const earnedOperations = (49444033n * 5n) / 100n;
  expect(earnedOperations >= result.operatingCostLamports).toBe(true);
  expect(earnedOperations < result.operatingCostLamports + result.temporaryFundingLamports).toBe(
    true
  );
});
it('does not repeatedly reserve rent for an existing token account during collection or buyback', async () => {
  for (const kind of ['collect', 'buyback'] as const)
    expect(await walletOperatingCosts(rpc([existing, null]), kind, 10000n, token, quote)).toEqual({
      operatingCostLamports: 10000n,
      temporaryFundingLamports: 2039280n,
    });
});
it('retains both new account rents as expenses for setup, which does not close wrapped SOL', async () => {
  expect(await walletOperatingCosts(rpc([null, null]), 'setup', 10000n, token, quote)).toEqual({
    operatingCostLamports: 4088560n,
    temporaryFundingLamports: 0n,
  });
  expect(
    await walletOperatingCosts(rpc([existing, existing]), 'setup', 10000n, token, quote)
  ).toEqual({
    operatingCostLamports: 10000n,
    temporaryFundingLamports: 0n,
  });
});
it('needs no account rent reads for a direct payout and refuses incomplete account observations', async () => {
  const connection = rpc([]);
  expect(await walletOperatingCosts(connection, 'creator_claim', 10000n)).toEqual({
    operatingCostLamports: 10000n,
    temporaryFundingLamports: 0n,
  });
  expect(connection.getMultipleAccountsInfo).not.toHaveBeenCalled();
  await expect(walletOperatingCosts(connection, 'collect', 10000n, token, quote)).rejects.toThrow(
    'unavailable'
  );
});
it('budgets a wXMR payment for temporary wrapped SOL and both wXMR accounts', async () => {
  expect(await walletOperatingCosts(rpc([]), 'wxmr_claim', 10000n)).toEqual({
    operatingCostLamports: 10000n + 2n * 2039280n,
    temporaryFundingLamports: 2039280n,
  });
});
