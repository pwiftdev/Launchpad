import { ComputeBudgetProgram, Transaction, type Message } from '@solana/web3.js';
import bs58 from 'bs58';
import { ringsBase64 } from './otcRingsPackets';
import type { RingsFunding } from './otcRingsRoom';

const lighthouse = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
const lighthouseFirstAssertion = 2;
const lighthouseLastAssertion = 17;
const computeBudget = ComputeBudgetProgram.programId.toBase58();
const maxComputeUnits = 1_400_000;
const maxPriorityFeeLamports = 1_000_000n;

function writableAccounts(message: Message) {
  return new Set(
    message.accountKeys.flatMap((key, index) =>
      message.isAccountWritable(index) ? [key.toBase58()] : []
    )
  );
}

export function matchesRingsFunding(expected: Message, signed: Message) {
  if (
    signed.recentBlockhash !== expected.recentBlockhash ||
    signed.header.numRequiredSignatures !== 1 ||
    signed.header.numReadonlySignedAccounts !== 0 ||
    !signed.accountKeys[0]?.equals(expected.accountKeys[0]!)
  )
    return false;

  const writable = writableAccounts(expected);
  const signedWritable = writableAccounts(signed);
  if (
    signedWritable.size !== writable.size ||
    [...signedWritable].some((key) => !writable.has(key))
  )
    return false;

  const deposit = expected.compiledInstructions;
  let cursor = 0;
  let units: number | undefined;
  let microLamports: bigint | undefined;
  for (const instruction of signed.compiledInstructions) {
    const program = signed.accountKeys[instruction.programIdIndex]?.toBase58();
    const { accountKeyIndexes, data } = instruction;
    const opcode = data[0];
    if (
      program === lighthouse &&
      opcode !== undefined &&
      opcode >= lighthouseFirstAssertion &&
      opcode <= lighthouseLastAssertion
    )
      continue;
    if (program === computeBudget && !accountKeyIndexes.length) {
      const bytes = Buffer.from(data);
      if (opcode === 2 && bytes.length === 5 && units === undefined) {
        units = bytes.readUInt32LE(1);
        if (units === 0 || units > maxComputeUnits) return false;
        continue;
      }
      if (opcode === 3 && bytes.length === 9 && microLamports === undefined) {
        microLamports = bytes.readBigUInt64LE(1);
        continue;
      }
      return false;
    }
    const base = deposit[cursor++];
    if (
      !base ||
      program !== expected.accountKeys[base.programIdIndex]?.toBase58() ||
      !Buffer.from(base.data).equals(data) ||
      base.accountKeyIndexes.length !== accountKeyIndexes.length ||
      !accountKeyIndexes.every((index, i) =>
        signed.accountKeys[index]?.equals(expected.accountKeys[base.accountKeyIndexes[i]!]!)
      )
    )
      return false;
  }
  return (
    cursor === deposit.length &&
    BigInt(units ?? maxComputeUnits) * (microLamports ?? 0n) <= maxPriorityFeeLamports * 1_000_000n
  );
}

export async function signRingsFunding(
  transaction: Transaction,
  lifetime: { blockhash: string; lastValidBlockHeight: bigint },
  sign: (transaction: Transaction) => Promise<Transaction>
): Promise<RingsFunding> {
  const expected = transaction.compileMessage();
  const signed = await sign(transaction);
  const signature = signed.signature;
  if (!signature) throw new Error('The wallet did not sign the funding transaction.');
  if (!matchesRingsFunding(expected, signed.compileMessage()))
    throw new Error('The wallet returned funding instructions that do not match this deal.');
  return {
    blockhash: lifetime.blockhash,
    lastValidBlockHeight: String(lifetime.lastValidBlockHeight),
    signature: bs58.encode(signature),
    transaction: ringsBase64(signed.serialize()),
  };
}
