import {
  type Bytes16,
  type Bytes32,
  type Bytes33,
  type Bytes128,
  type TransactInstructionData,
} from '@heliuslabs/spr/interface';
import {
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  type Address,
  type SignatureBytes,
  type Transaction,
  type TransactionMessageBytes,
} from '@solana/kit';
import { z } from 'zod';
import { wireBytes, type RingsPartial } from './otcRingsRoom';

const encode = getBase64Decoder();
const decode = getBase64Encoder();
export const ringsBase64 = (value: Parameters<typeof encode.decode>[0]) => encode.decode(value);
export const ringsBytes = (value: string) => Uint8Array.from(decode.encode(value));
const field = (size: number) =>
  z
    .base64()
    .length(Math.ceil(size / 3) * 4)
    .refine((value) => ringsBytes(value).length === size);
const wire = z.strictObject({
  expiry: z.string().regex(/^\d{1,12}$/),
  hash: field(32),
  viewing: field(33),
  salt: field(16),
  a: field(32),
  b: field(128),
  c: field(32),
  nullifier: field(32),
  output: field(32),
  owner: field(32),
  data: wireBytes(4000),
  utxoRoot: z
    .number()
    .int()
    .nonnegative()
    .max(2 ** 32 - 1),
  nullifierRoot: z
    .number()
    .int()
    .nonnegative()
    .max(2 ** 32 - 1),
  slots: z.number().int().min(1).max(4),
});

export function encodeRingsProof(proof: TransactInstructionData) {
  const [input] = proof.inputs;
  const [output] = proof.outputs;
  const [context] = proof.treeContexts;
  if (
    proof.circuit.kind !== 'confidentialSigner' ||
    proof.circuit.inputs !== 1 ||
    proof.circuit.outputs !== 2 ||
    proof.inputs.length !== 1 ||
    proof.treeContexts.length !== 1 ||
    proof.outputs.length !== 1 ||
    input?.treeIndex !== 0 ||
    !context ||
    !output?.data ||
    output.ownerTag.kind !== 'inline' ||
    proof.interfaceTransfers.length ||
    proof.messages.length ||
    proof.dataHash ||
    proof.ringDataHash
  )
    throw new Error('The proof is outside the supported OTC circuit.');
  return JSON.stringify(
    wire.parse({
      expiry: String(proof.expiryUnixTs),
      hash: ringsBase64(proof.privateTxHash),
      viewing: ringsBase64(proof.txViewingPk),
      salt: ringsBase64(proof.salt),
      a: ringsBase64(proof.proof.a),
      b: ringsBase64(proof.proof.b),
      c: ringsBase64(proof.proof.c),
      nullifier: ringsBase64(input.nullifierHash),
      output: ringsBase64(output.utxoHash),
      owner: ringsBase64(output.ownerTag.value),
      data: ringsBase64(output.data),
      utxoRoot: context.utxoTreeRootIndex,
      nullifierRoot: context.nullifierTreeRootIndex,
      slots: proof.circuit.publicAssetSlots,
    })
  );
}

export function decodeRingsProof(value: string): TransactInstructionData {
  const data = wire.parse(JSON.parse(value));
  return {
    expiryUnixTs: BigInt(data.expiry),
    privateTxHash: ringsBytes(data.hash) as Bytes32,
    txViewingPk: ringsBytes(data.viewing) as Bytes33,
    salt: ringsBytes(data.salt) as Bytes16,
    proof: {
      a: ringsBytes(data.a) as Bytes32,
      b: ringsBytes(data.b) as Bytes128,
      c: ringsBytes(data.c) as Bytes32,
    },
    circuit: { kind: 'confidentialSigner', inputs: 1, outputs: 2, publicAssetSlots: data.slots },
    inputs: [{ treeIndex: 0, nullifierHash: ringsBytes(data.nullifier) as Bytes32 }],
    outputs: [
      {
        utxoHash: ringsBytes(data.output) as Bytes32,
        ownerTag: { kind: 'inline', value: ringsBytes(data.owner) as Bytes32 },
        data: ringsBytes(data.data),
      },
    ],
    treeContexts: [
      { utxoTreeRootIndex: data.utxoRoot, nullifierTreeRootIndex: data.nullifierRoot },
    ],
    interfaceTransfers: [],
    messages: [],
  };
}

export function packRingsPartial(transaction: Transaction, signer: Address): RingsPartial {
  const signature = transaction.signatures[signer];
  if (!signature) throw new Error('The wallet did not sign the settlement.');
  return { message: ringsBase64(transaction.messageBytes), signature: ringsBase64(signature) };
}

export function unpackRingsPartial(packet: RingsPartial, signer: Address): Transaction {
  const messageBytes = ringsBytes(packet.message) as unknown as TransactionMessageBytes;
  const signature = ringsBytes(packet.signature) as SignatureBytes;
  const message = getCompiledTransactionMessageDecoder().decode(messageBytes);
  const addresses = message.staticAccounts.slice(0, message.header.numSignerAccounts);
  if (addresses.length !== 2 || !addresses.some((key) => key === signer) || signature.length !== 64)
    throw new Error('The counterparty signature is invalid.');
  return {
    messageBytes,
    signatures: Object.fromEntries(
      addresses.map((key) => [key, key === signer ? signature : null])
    ),
  };
}
