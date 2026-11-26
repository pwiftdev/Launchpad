import { SOL_MINT, ShieldedAddress, type Address } from '@heliuslabs/spr';
import { getTreeAddress } from '@heliuslabs/spr/addresses';
import { getCreateSplInterfaceInstructionAsync } from '@heliuslabs/spr/instructions';
import { DEFAULT_TREE_ID, DepositAsset, depositInstruction } from '@heliuslabs/spr/interface';
import { address, getAddressDecoder, type Instruction } from '@solana/kit';
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { NETWORK_GENESIS } from '../../../../scripts/network-policy.cjs';
import {
  OTC_FEE_RESERVE,
  otcAmountUnits,
  otcLegAsset,
  type OtcAsset,
  type OtcLeg,
  type OtcTerms,
} from './otc';
import { ringsBytes } from './otcRingsPackets';
import type { RingsRoom, RingsSide } from './otcRingsRoom';

export { OTC_FEE_RESERVE };

const mainUsdc = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const testUsdc = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const genesis = NETWORK_GENESIS['mainnet-beta'];
export const ringsAsset = (asset: OtcAsset, network: string, local?: string) =>
  asset === 'SOL'
    ? SOL_MINT
    : network === genesis
      ? mainUsdc
      : network === NETWORK_GENESIS.devnet || !local
        ? testUsdc
        : address(local);

export function dealAddress(key: string | null) {
  if (!key) throw new Error('The deal wallet has not been registered.');
  return ShieldedAddress.fromBytes(ringsBytes(key));
}

export function dealLeg(room: RingsRoom, side: RingsSide) {
  const leg = dealTermsLeg(room.terms, side);
  const amount = otcAmountUnits(otcLegAsset(leg), leg.amount);
  if (amount === null) throw new Error('The deal amount is invalid.');
  return {
    owner: dealAddress(room[side].key),
    asset: ringsLegMint(leg, room),
    tokenProgram:
      leg.asset === 'TOKEN' && leg.token.program === 'token-2022'
        ? ringsToken2022
        : ringsTokenProgram,
    amount,
  };
}

export const dealTermsLeg = (terms: OtcTerms, side: RingsSide) =>
  side === 'maker' ? terms.sell : terms.buy;

export function ringsLegMint(leg: OtcLeg, room: Pick<RingsRoom, 'genesis' | 'localUsdc'>) {
  return leg.asset === 'TOKEN'
    ? address(leg.token.mint)
    : ringsAsset(leg.asset, room.genesis, room.localUsdc);
}

const pubkey = (value: Address) => new PublicKey(value);
export function ringsTokenAccount(asset: Address, owner: Address, program = ringsTokenProgram) {
  return address(
    getAssociatedTokenAddressSync(pubkey(asset), pubkey(owner), false, pubkey(program)).toBase58()
  );
}
export const ringsTokenProgram = getAddressDecoder().decode(TOKEN_PROGRAM_ID.toBytes());
const ringsToken2022 = getAddressDecoder().decode(TOKEN_2022_PROGRAM_ID.toBytes());

function legacyInstruction(instruction: Instruction) {
  return new TransactionInstruction({
    programId: pubkey(instruction.programAddress),
    data: Buffer.from(instruction.data ?? []),
    keys: (instruction.accounts ?? []).map((account) => ({
      pubkey: pubkey(account.address),
      isSigner: account.role >= 2,
      isWritable: (account.role & 1) === 1,
    })),
  });
}

export async function buildRingsDeposit(
  room: RingsRoom,
  payer: Address,
  blockhash: string,
  registerToken = false
) {
  const { owner, asset, amount, tokenProgram } = dealLeg(room, room.side);
  const recipient = owner.solanaAddress();
  if (recipient === payer)
    throw new Error('The deal wallet must differ from the connected wallet.');
  const deposit = await depositInstruction({
    tree: getTreeAddress(DEFAULT_TREE_ID),
    depositor: payer,
    deposits: [
      {
        asset:
          asset === SOL_MINT
            ? DepositAsset.sol()
            : DepositAsset.spl({
                mint: asset,
                sourceTokenAccount: ringsTokenAccount(asset, payer, tokenProgram),
                tokenProgram,
              }),
        viewTag: owner.confidentialViewTag(),
        recipientOwnerHash: owner.ownerHash(),
        amount,
      },
    ],
  });
  if (registerToken && dealTermsLeg(room.terms, room.side).asset !== 'TOKEN')
    throw new Error('Only the launch-token depositor can set up its Rings account.');
  const setup = registerToken
    ? [
        legacyInstruction(
          await getCreateSplInterfaceInstructionAsync({
            authority: payer,
            mint: asset,
            tokenProgram,
          })
        ),
      ]
    : [];
  return new Transaction({ feePayer: pubkey(payer), recentBlockhash: blockhash }).add(
    ...setup,
    SystemProgram.transfer({
      fromPubkey: pubkey(payer),
      toPubkey: pubkey(recipient),
      lamports: OTC_FEE_RESERVE,
    }),
    legacyInstruction(deposit)
  );
}
