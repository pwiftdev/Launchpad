import { Connection, PublicKey } from '@solana/web3.js';
import { fundingAddress, vaultAddresses } from '@/lib/vault/client';
import { assertFinalizedEvidence, type FinalizedEvidence } from './chainEvidence';

const receipts = new WeakSet<object>();
export type VerifiedFundingReceipt = {
  networkGenesis: string;
  mint: string;
  signature: string;
  messageDigest: string;
  commitment: string;
  fundingId: string;
  address: string;
  coin: string;
  slot: number;
  total: bigint;
  rinseNetBefore: bigint;
  postNetBefore: bigint;
};
export function assertFundingReceipt(receipt: VerifiedFundingReceipt): void {
  if (!receipts.has(receipt))
    throw new Error('Funding requires an independently verified immutable program receipt');
}
export async function verifyFundingReceipt(
  rpc: Connection,
  evidence: FinalizedEvidence,
  input: { program: string; mint: string; fundingId: string; commitment: string; total: bigint }
): Promise<VerifiedFundingReceipt> {
  assertFinalizedEvidence(evidence);
  if (input.fundingId !== input.commitment || !/^[a-f0-9]{64}$/.test(input.commitment))
    throw new Error('Invalid funding identity');
  if ((await rpc.getGenesisHash()) !== evidence.networkGenesis)
    throw new Error('Funding receipt network mismatch');
  const program = new PublicKey(input.program),
    { coin } = vaultAddresses(program, new PublicKey(input.mint));
  const address = fundingAddress(program, coin, input.fundingId);
  const response = await rpc.getAccountInfoAndContext(address, {
    commitment: 'finalized',
    minContextSlot: evidence.slot,
  });
  const account = response.value;
  const data = account?.data;
  if (
    response.context.slot < evidence.slot ||
    !account?.owner.equals(program) ||
    !data ||
    data.length !== 138 ||
    data.subarray(0, 8).toString() !== 'RFUND001' ||
    data[8] !== 1 ||
    !data.subarray(10, 42).equals(coin.toBuffer()) ||
    data.subarray(42, 74).toString('hex') !== input.fundingId ||
    data.subarray(74, 106).toString('hex') !== input.commitment ||
    data.readBigUInt64LE(106) !== input.total ||
    data.readBigUInt64LE(114) !== BigInt(evidence.slot)
  )
    throw new Error('Immutable finalized funding receipt does not match the deposit');
  const result: VerifiedFundingReceipt = {
    networkGenesis: evidence.networkGenesis,
    mint: input.mint,
    signature: evidence.signature,
    messageDigest: evidence.messageDigest,
    commitment: input.commitment,
    fundingId: input.fundingId,
    address: address.toBase58(),
    coin: coin.toBase58(),
    slot: evidence.slot,
    total: input.total,
    rinseNetBefore: data.readBigUInt64LE(122),
    postNetBefore: data.readBigUInt64LE(130),
  };
  receipts.add(result);
  return result;
}
