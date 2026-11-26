import { type Address, type ShieldedAddress, type ShieldedKeypair } from '@heliuslabs/spr';
import { getTreeAddress } from '@heliuslabs/spr/addresses';
import type { SprClient } from '@heliuslabs/spr/client';
import {
  checkedTransactionSize,
  DEFAULT_TREE_ID,
  transactInstruction,
  type TransactInstructionData,
} from '@heliuslabs/spr/interface';
import { X25519PublicKey } from '@heliuslabs/spr/keypair';
import {
  ConfidentialTransfer,
  createExternalData,
  decodeConfidential,
  decodeOutputData,
  EncryptedScheme,
  SppProofInputs,
  Utxo,
  type AssetRegistry,
  type ProofInputUtxo,
} from '@heliuslabs/spr/transaction';
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getPublicKeyFromAddress,
  partiallySignTransactionWithSigners,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  verifySignature,
  type Transaction,
} from '@solana/kit';

type Side = 'maker' | 'taker';
type Leg = { owner: ShieldedAddress; asset: Address; amount: bigint };
export type RingsSwap = Record<Side, Leg> & { expiresAt: bigint };
type Lifetime = Awaited<ReturnType<SprClient['getLatestBlockhash']>>;
type Proofs = Record<Side, TransactInstructionData>;

const sides = ['maker', 'taker'] as const;
const tree = getTreeAddress(DEFAULT_TREE_ID);
const otherSide = (side: Side): Side => (side === 'maker' ? 'taker' : 'maker');
function sameBytes(left: ArrayLike<number>, right: ArrayLike<number>) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function requireActiveSwap(swap: RingsSwap, side: Side, wallet: ShieldedKeypair) {
  if (swap.expiresAt <= BigInt(Math.floor(Date.now() / 1000)))
    throw new Error('OTC offer expired.');
  if (
    swap.maker.owner.solanaAddress() === swap.taker.owner.solanaAddress() ||
    swap.maker.asset === swap.taker.asset ||
    sides.some((party) => swap[party].amount <= 0n) ||
    !sameBytes(swap[side].owner.toBytes(), wallet.shieldedAddress().toBytes())
  ) {
    throw new Error('The Rings wallets or amounts do not match the OTC deal.');
  }
}

function requireFunding(leg: Leg, funding: ProofInputUtxo) {
  if (
    funding.treeId !== DEFAULT_TREE_ID ||
    funding.utxo.asset !== leg.asset ||
    funding.utxo.amount !== leg.amount ||
    funding.utxo.ringProgramId ||
    funding.utxo.data.records().length
  ) {
    throw new Error('The private funding note does not match the OTC deal.');
  }
}

export async function proveRingsSwapLeg(input: {
  swap: RingsSwap;
  side: Side;
  wallet: ShieldedKeypair;
  funding: ProofInputUtxo;
  assets: AssetRegistry;
  client: Pick<SprClient, 'proveTransact'>;
}) {
  const { swap, side, wallet, funding, assets, client } = input;
  requireActiveSwap(swap, side, wallet);
  requireFunding(swap[side], funding);
  const { owner, asset, amount } = swap[side];

  const transfer = ConfidentialTransfer.compact(owner, [funding], swap.taker.owner.solanaAddress());
  transfer.send(swap[otherSide(side)].owner, asset, amount);
  const prepared = transfer.sign(wallet, assets);
  const proofInputs = new SppProofInputs({
    ...prepared,
    externalData: createExternalData({ ...prepared.externalData, expiryUnixTs: swap.expiresAt }),
  });
  return client.proveTransact(proofInputs, [wallet]);
}

function readSwapOutput(swap: RingsSwap, side: Side, proof: TransactInstructionData) {
  const [output] = proof.outputs;
  if (
    proof.expiryUnixTs !== swap.expiresAt ||
    proof.circuit.kind !== 'confidentialSigner' ||
    proof.inputs.length !== 1 ||
    proof.inputs[0]?.treeIndex !== 0 ||
    proof.treeContexts.length !== 1 ||
    proof.interfaceTransfers.length ||
    proof.messages.length ||
    proof.dataHash ||
    proof.ringDataHash ||
    proof.outputs.length !== 1 ||
    !output?.data ||
    output.ownerTag.kind !== 'inline' ||
    !sameBytes(output.ownerTag.value, swap[otherSide(side)].owner.confidentialViewTag())
  ) {
    throw new Error('The private transfer does not match the OTC deal.');
  }
  return { commitment: output.utxoHash, ...decodeOutputData(output.data) };
}

function verifyLegAmount(
  leg: Leg,
  receiver: ShieldedAddress,
  assets: AssetRegistry,
  commitment: Uint8Array,
  decrypted: Uint8Array
) {
  try {
    const payment = decodeConfidential(decrypted);
    const asset = assets.resolve(payment.assetId);
    const note = new Utxo({
      owner: receiver.signingPublicKey,
      asset,
      amount: payment.amount,
      blinding: payment.blinding,
    });
    if (
      asset !== leg.asset ||
      payment.amount !== leg.amount ||
      payment.ringProgramId ||
      payment.data.records().length ||
      !sameBytes(note.hash(receiver.nullifierPublicKey, DEFAULT_TREE_ID), commitment)
    ) {
      throw new Error('The private balance does not match the agreed asset and amount.');
    }
  } finally {
    decrypted.fill(0);
  }
}

function verifyLeg(
  swap: RingsSwap,
  sender: Side,
  proof: TransactInstructionData,
  decrypt: (ciphertext: Uint8Array, viewKey: X25519PublicKey) => Uint8Array,
  assets: AssetRegistry
) {
  const receiver = swap[otherSide(sender)].owner;
  const { commitment, encoding, scheme, body } = readSwapOutput(swap, sender, proof);
  if (
    encoding !== 'encrypted' ||
    scheme !== EncryptedScheme.confidential ||
    !sameBytes(body.subarray(0, 33), receiver.viewingPublicKey.toBytes())
  ) {
    throw new Error('The transfer is not encrypted for the agreed wallet.');
  }
  const decrypted = decrypt(body.subarray(33), X25519PublicKey.fromBytes(proof.txViewingPk));
  verifyLegAmount(swap[sender], receiver, assets, commitment, decrypted);
}

export async function signRingsSwap(input: {
  swap: RingsSwap;
  side: Side;
  wallet: ShieldedKeypair;
  funding: ProofInputUtxo;
  outgoing: TransactInstructionData;
  incoming: TransactInstructionData;
  assets: AssetRegistry;
  lifetime: Lifetime;
}) {
  const { swap, side, wallet, funding, outgoing, incoming, assets, lifetime } = input;
  requireActiveSwap(swap, side, wallet);
  requireFunding(swap[side], funding);
  const nullifier = funding.nullifier();
  if (!outgoing.inputs[0] || !sameBytes(outgoing.inputs[0].nullifierHash, nullifier)) {
    throw new Error('The outgoing transfer spends a different funding note.');
  }
  const receiver = swap[otherSide(side)].owner;
  const transactionKey = wallet.transactionViewingKey(nullifier);
  try {
    verifyLeg(
      swap,
      side,
      outgoing,
      (ciphertext, viewKey) => {
        if (!viewKey.equals(transactionKey.publicKey()))
          throw new Error('The transfer viewing key has changed.');
        return transactionKey.decryptSlotEphemeral(
          receiver.viewingPublicKey,
          ciphertext,
          outgoing.salt,
          0
        );
      },
      assets
    );
  } finally {
    transactionKey.destroy();
  }
  verifyLeg(
    swap,
    otherSide(side),
    incoming,
    (ciphertext, viewKey) => wallet.decryptUtxo(ciphertext, viewKey, incoming.salt, 0),
    assets
  );
  const proofs: Proofs =
    side === 'maker' ? { maker: outgoing, taker: incoming } : { maker: incoming, taker: outgoing };
  const payer = swap.taker.owner.solanaAddress();
  const instructions = await Promise.all(
    sides.map((party) =>
      transactInstruction({
        payer,
        inputTree: tree,
        outputTree: tree,
        ownerSigners: [swap[party].owner.solanaAddress()],
        data: proofs[party],
      })
    )
  );
  const transaction = checkedTransactionSize(
    pipe(
      createTransactionMessage({ version: 1 }),
      (message) => setTransactionMessageFeePayer(payer, message),
      (message) => setTransactionMessageLifetimeUsingBlockhash(lifetime, message),
      (message) =>
        setTransactionMessageConfig(
          { computeUnitLimit: 1_400_000, loadedAccountsDataSizeLimit: 64 * 1024 * 1024 },
          message
        ),
      (message) => appendTransactionMessageInstructions(instructions, message),
      compileTransaction
    )
  );
  return partiallySignTransactionWithSigners([wallet.toSolanaSigner()], transaction);
}

export async function combineRingsSwapSignatures(
  swap: RingsSwap,
  maker: Transaction,
  taker: Transaction
) {
  const makerAddress = swap.maker.owner.solanaAddress();
  const takerAddress = swap.taker.owner.solanaAddress();
  const makerSignature = maker.signatures[makerAddress];
  const takerSignature = taker.signatures[takerAddress];
  if (
    makerAddress === takerAddress ||
    !makerSignature ||
    !takerSignature ||
    Object.keys(maker.signatures).length !== 2 ||
    Object.keys(taker.signatures).length !== 2 ||
    maker.signatures[takerAddress] !== null ||
    taker.signatures[makerAddress] !== null ||
    !sameBytes(maker.messageBytes, taker.messageBytes)
  ) {
    throw new Error('The two signatures are for different settlement transactions.');
  }
  const verified = await Promise.all([
    verifySignature(
      await getPublicKeyFromAddress(makerAddress),
      makerSignature,
      maker.messageBytes
    ),
    verifySignature(
      await getPublicKeyFromAddress(takerAddress),
      takerSignature,
      taker.messageBytes
    ),
  ]);
  if (verified.some((valid) => !valid))
    throw new Error('A settlement signature could not be verified.');
  return { ...maker, signatures: { ...maker.signatures, [takerAddress]: takerSignature } };
}
