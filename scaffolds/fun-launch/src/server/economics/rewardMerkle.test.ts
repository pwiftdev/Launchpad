import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { vaultAddresses } from '@/lib/vault/client';
import { buildRewardMerkle, rewardLeaf, verifyRewardProof } from './rewardMerkle';
import { fixtureWallet } from './financialFixtures';

describe('funded hourly claim commitments', () => {
  it('verifies odd-sized trees and binds program, coin, epoch, owner and amount', () => {
    const program = fixtureWallet().publicKey,
      mint = fixtureWallet().publicKey;
    const allocations = Array.from({ length: 7 }, (_, index) => ({
      wallet: fixtureWallet().publicKey.toBase58(),
      lamports: BigInt(index + 1),
    }));
    const plan = buildRewardMerkle(program.toBase58(), mint.toBase58(), 12, allocations);
    const coin = vaultAddresses(program, mint).coin;
    expect(
      buildRewardMerkle(program.toBase58(), mint.toBase58(), 12, [...allocations].reverse()).root
    ).toBe(plan.root);
    for (const item of plan.allocations) {
      const owner = new PublicKey(item.wallet);
      expect(
        verifyRewardProof(
          rewardLeaf(program, coin, 12n, owner, item.lamports),
          item.proof,
          plan.root
        )
      ).toBe(true);
      expect(
        verifyRewardProof(
          rewardLeaf(program, coin, 13n, owner, item.lamports),
          item.proof,
          plan.root
        )
      ).toBe(false);
      expect(
        verifyRewardProof(
          rewardLeaf(program, coin, 12n, owner, item.lamports + 1n),
          item.proof,
          plan.root
        )
      ).toBe(false);
      expect(
        verifyRewardProof(
          rewardLeaf(fixtureWallet().publicKey, coin, 12n, owner, item.lamports),
          item.proof,
          plan.root
        )
      ).toBe(false);
    }
    expect(() =>
      buildRewardMerkle(program.toBase58(), mint.toBase58(), 12, [allocations[0]!, allocations[0]!])
    ).toThrow('Duplicate');
  });
});
