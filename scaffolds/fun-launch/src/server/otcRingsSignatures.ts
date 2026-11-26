import {
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getSignatureFromTransaction,
  getTransactionDecoder,
  verifySignature,
} from '@solana/kit';
import { SHIELDED_POOL_PROGRAM_ID } from '@heliuslabs/spr';
import { ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { dealAddress } from '@/lib/otcRingsDeposit';
import { ringsBytes, unpackRingsPartial } from '@/lib/otcRingsPackets';
import type { RingsFunding, RingsPartial, RingsRoom } from '@/lib/otcRingsRoom';
import { SocialError } from './profileStore';
import { SystemProgram } from '@solana/web3.js';

const messageDecoder = getCompiledTransactionMessageDecoder();
const associated = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();

export async function validateRingsSignature(room: RingsRoom, id: string, partial: RingsPartial) {
  try {
    const attempt = room.attempt;
    const own = dealAddress(room[room.side].key).solanaAddress();
    const payer = dealAddress(room.taker.key).solanaAddress();
    const decoded = unpackRingsPartial(partial, own);
    const message = messageDecoder.decode(decoded.messageBytes);
    const signature = decoded.signatures[own];
    if (
      !attempt ||
      !signature ||
      attempt.id !== id ||
      message.version !== 1 ||
      message.numInstructions !== 2 ||
      message.instructionHeaders.some(
        ({ programAccountIndex }) =>
          message.staticAccounts[programAccountIndex] !== SHIELDED_POOL_PROGRAM_ID
      ) ||
      !message.staticAccounts.slice(0, 2).includes(dealAddress(room.maker.key).solanaAddress()) ||
      message.staticAccounts[0] !== payer ||
      message.lifetimeToken !== attempt.lifetime.blockhash ||
      (attempt.maker && attempt.maker.message !== partial.message) ||
      (attempt.taker && attempt.taker.message !== partial.message) ||
      !(await verifySignature(await getPublicKeyFromAddress(own), signature, decoded.messageBytes))
    )
      throw new Error();
  } catch {
    throw new SocialError('The settlement signature did not match the deal.', 400);
  }
}

export async function validateRingsWithdrawal(
  room: RingsRoom,
  withdrawal: RingsFunding,
  reserveRecipient?: string
) {
  try {
    const own = dealAddress(room[room.side].key).solanaAddress();
    const decoded = getTransactionDecoder().decode(ringsBytes(withdrawal.transaction));
    const message = messageDecoder.decode(decoded.messageBytes);
    const signature = decoded.signatures[own];
    if (
      !signature ||
      message.version !== 1 ||
      message.header.numSignerAccounts !== 1 ||
      message.staticAccounts[0] !== own ||
      message.lifetimeToken !== withdrawal.blockhash ||
      getSignatureFromTransaction(decoded) !== withdrawal.signature ||
      !(await verifySignature(await getPublicKeyFromAddress(own), signature, decoded.messageBytes))
    )
      throw new Error();
    if (reserveRecipient) {
      const [header] = message.instructionHeaders;
      const [payload] = message.instructionPayloads;
      if (
        message.numInstructions !== 1 ||
        message.staticAccounts[header!.programAccountIndex] !==
          SystemProgram.programId.toBase58() ||
        payload!.instructionAccountIndices.length !== 2 ||
        message.staticAccounts[payload!.instructionAccountIndices[0]!] !== own ||
        message.staticAccounts[payload!.instructionAccountIndices[1]!] !== reserveRecipient ||
        payload!.instructionData.length !== 12 ||
        new DataView(Uint8Array.from(payload!.instructionData).buffer).getUint32(0, true) !== 2
      )
        throw new Error();
    } else {
      const programs = message.instructionHeaders.map(
        ({ programAccountIndex }) => message.staticAccounts[programAccountIndex]
      );
      if (
        programs.join() !== SHIELDED_POOL_PROGRAM_ID &&
        programs.join() !== `${associated},${SHIELDED_POOL_PROGRAM_ID}`
      )
        throw new Error();
    }
  } catch {
    throw new SocialError('The withdrawal signature did not match the deal wallet.', 400);
  }
}
