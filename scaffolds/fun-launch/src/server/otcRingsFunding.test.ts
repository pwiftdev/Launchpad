import { initializePoseidon, ShieldedKeypair, SigningKey } from '@heliuslabs/spr';
import { address } from '@solana/kit';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildRingsDeposit } from '@/lib/otcRingsDeposit';
import { signRingsFunding } from '@/lib/otcRingsFunding';
import { ringsBase64 } from '@/lib/otcRingsPackets';
import type { RingsRoom, RingsSide } from '@/lib/otcRingsRoom';
import { verifyFundingPacket } from './otcRingsRetry';

const lighthouse = new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');
const payer = Keypair.generate();
const wallet = address(payer.publicKey.toBase58());
const lifetime = { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100n };
let room: RingsRoom;

beforeAll(async () => {
  await initializePoseidon();
  const party = (): RingsRoom['maker'] => {
    const key = ShieldedKeypair.fromKeypair(SigningKey.generate());
    try {
      return {
        key: ringsBase64(key.shieldedAddress().toBytes()),
        funding: null,
        proof: null,
        withdrawal: null,
        reserve: null,
      };
    } finally {
      key.destroy();
    }
  };
  room = {
    id: 'eeb96177-6e20-48b4-bac2-e854223b15d0',
    origin: 'https://mskd.fun',
    genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    side: 'maker',
    terms: { sell: { asset: 'SOL', amount: '0.1' }, buy: { asset: 'USDC', amount: '12' } },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maker: party(),
    taker: party(),
    attempt: null,
  };
});

const priority = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 12_000n });
const guard = (opcode = 6, writable = false) =>
  new TransactionInstruction({
    programId: lighthouse,
    data: Buffer.from([opcode, 0, 0, 0]),
    keys: [{ pubkey: PublicKey.default, isSigner: false, isWritable: writable }],
  });

async function approve(
  change: (transaction: Transaction) => void = () => {},
  side: RingsSide = 'maker'
) {
  const selected = { ...room, side };
  const tx = await buildRingsDeposit(selected, wallet, lifetime.blockhash);
  return signRingsFunding(tx, lifetime, async (transaction) => {
    change(transaction);
    transaction.sign(payer);
    return Transaction.from(transaction.serialize());
  });
}

describe('wallet-signed Rings funding', () => {
  it.each<RingsSide>(['maker', 'taker'])(
    'accepts the original and wallet-adjusted %s deposit on the browser and server',
    async (side) => {
      const original = await approve(undefined, side);
      const adjusted = await approve((tx) => {
        tx.instructions.unshift(
          priority,
          ComputeBudgetProgram.setComputeUnitLimit({ units: 420_000 })
        );
        tx.add(guard());
      }, side);
      expect(adjusted.transaction).not.toBe(original.transaction);
      for (const funding of [original, adjusted]) {
        await expect(
          verifyFundingPacket(funding, wallet, { ...room, side })
        ).resolves.toBeUndefined();
      }
    }
  );

  it.each<[string, (transaction: Transaction) => void]>([
    ['a changed reserve amount', (tx) => tx.instructions[0]!.data.writeBigUInt64LE(7_000_000n, 4)],
    [
      'changed deposit bytes',
      (tx) => {
        const { data } = tx.instructions[1]!;
        data.writeUInt8(data.readUInt8(2) ^ 1, 2);
      },
    ],
    [
      'a changed recipient',
      (tx) => (tx.instructions[0]!.keys[1]!.pubkey = Keypair.generate().publicKey),
    ],
    ['a changed blockhash', (tx) => (tx.recentBlockhash = Keypair.generate().publicKey.toBase58())],
    ['a swapped instruction order', (tx) => tx.instructions.reverse()],
    [
      'an unrelated transfer',
      (tx) =>
        tx.add(
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: tx.instructions[0]!.keys[1]!.pubkey,
            lamports: 1,
          })
        ),
    ],
    ['a Lighthouse memory write', (tx) => tx.add(guard(0))],
    ['a Lighthouse memory close', (tx) => tx.add(guard(1))],
    ['an unknown Lighthouse instruction', (tx) => tx.add(guard(18))],
    ['additional writable privileges', (tx) => tx.add(guard(6, true))],
    ['duplicate fee instructions', (tx) => tx.add(priority, priority)],
    [
      'an excessive priority fee',
      (tx) => tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000n })),
    ],
  ])('rejects %s after the wallet signs', async (_description, change) => {
    await expect(approve(change)).rejects.toThrow('do not match this deal');
  });

  it('rejects an altered blockhash or a different deal on the server', async () => {
    const funding = await approve();
    await expect(
      verifyFundingPacket(
        { ...funding, blockhash: Keypair.generate().publicKey.toBase58() },
        wallet,
        room
      )
    ).rejects.toHaveProperty('status', 400);
    await expect(
      verifyFundingPacket(funding, wallet, { ...room, side: 'taker' })
    ).rejects.toHaveProperty('status', 400);
  });
});
