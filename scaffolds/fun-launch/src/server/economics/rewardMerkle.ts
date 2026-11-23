import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { u64, vaultAddresses } from '@/lib/vault/client';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();
export function rewardLeaf(
  programId: PublicKey,
  coin: PublicKey,
  epoch: bigint,
  wallet: PublicKey,
  amount: bigint
): Buffer {
  if (amount <= 0n) throw new Error('Reward amount must be positive');
  return sha(
    Buffer.concat([
      Buffer.from('rinse-claim-v1'),
      programId.toBuffer(),
      coin.toBuffer(),
      u64(epoch),
      wallet.toBuffer(),
      u64(amount),
    ])
  );
}
export function rewardParent(a: Uint8Array, b: Uint8Array): Buffer {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  if (x.length !== 32 || y.length !== 32) throw new Error('Merkle nodes must contain 32 bytes');
  return sha(Buffer.compare(x, y) <= 0 ? Buffer.concat([x, y]) : Buffer.concat([y, x]));
}
export function buildRewardMerkle(
  program: string,
  mint: string,
  epoch: number,
  allocations: { wallet: string; lamports: bigint }[]
) {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('Invalid reward epoch');
  const programKey = new PublicKey(program),
    coin = vaultAddresses(programKey, new PublicKey(mint)).coin;
  const seen = new Set<string>();
  const leaves = allocations
    .map((allocation) => {
      if (seen.has(allocation.wallet)) throw new Error('Duplicate owner in reward allocation');
      seen.add(allocation.wallet);
      return {
        ...allocation,
        leaf: rewardLeaf(
          programKey,
          coin,
          BigInt(epoch),
          new PublicKey(allocation.wallet),
          allocation.lamports
        ),
      };
    })
    .sort((a, b) => Buffer.compare(a.leaf, b.leaf));
  const levels: Buffer[][] = [leaves.map((leaf) => leaf.leaf)];
  while (levels.at(-1)!.length > 1) {
    const previous = levels.at(-1)!,
      next: Buffer[] = [];
    for (let i = 0; i < previous.length; i += 2)
      next.push(previous[i + 1] ? rewardParent(previous[i]!, previous[i + 1]!) : previous[i]!);
    levels.push(next);
  }
  return {
    root: (levels.at(-1)![0] ?? Buffer.alloc(32)).toString('hex'),
    allocations: leaves.map((item, index) => {
      const proof: string[] = [];
      let position = index;
      for (let level = 0; level < levels.length - 1; level++) {
        const sibling = levels[level]![position ^ 1];
        if (sibling) proof.push(sibling.toString('hex'));
        position = Math.floor(position / 2);
      }
      return { wallet: item.wallet, lamports: item.lamports, proof };
    }),
  };
}
export function verifyRewardProof(
  leaf: Uint8Array,
  proof: readonly string[],
  root: string
): boolean {
  if (leaf.length !== 32 || proof.length > 32 || !/^[a-f0-9]{64}$/.test(root)) return false;
  let result: Buffer = Buffer.from(leaf);
  for (const sibling of proof) {
    if (!/^[a-f0-9]{64}$/.test(sibling)) return false;
    result = rewardParent(result, Buffer.from(sibling, 'hex'));
  }
  return result.toString('hex') === root;
}
