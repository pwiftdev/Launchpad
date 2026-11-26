import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { initializePoseidon, SHIELDED_POOL_PROGRAM_ID } from '@heliuslabs/spr';
import { getSplAssetRegistryAddress } from '@heliuslabs/spr/addresses';
import { decodeSplAssetRegistry } from '@heliuslabs/spr/interface';
import { recordRpcUsage } from './rpcUsage';
import { address } from '@solana/kit';
import bs58 from 'bs58';
import { buildRingsDeposit, dealTermsLeg } from '@/lib/otcRingsDeposit';
import { matchesRingsFunding } from '@/lib/otcRingsFunding';
import { otherRingsSide, type RingsFunding, type RingsRoom } from '@/lib/otcRingsRoom';
import { SocialError } from './profileStore';

export function ringsConnection(rpc: URL) {
  return new Connection(rpc.toString(), {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: (url, options) => {
      recordRpcUsage('rings', options?.body);
      return fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(7000) });
    },
  });
}

export async function verifyFundingPacket(funding: RingsFunding, wallet: string, room: RingsRoom) {
  try {
    await initializePoseidon();
    const wire = Buffer.from(funding.transaction, 'base64');
    const transaction = Transaction.from(wire);
    const expected = await buildRingsDeposit(
      room,
      address(wallet),
      funding.blockhash,
      funding.registerToken
    );
    if (
      transaction.recentBlockhash !== funding.blockhash ||
      transaction.feePayer?.toBase58() !== wallet ||
      !transaction.signature ||
      bs58.encode(transaction.signature) !== funding.signature ||
      !transaction.serialize().equals(wire) ||
      !matchesRingsFunding(expected.compileMessage(), transaction.compileMessage())
    )
      throw new Error('Invalid signed transaction');
  } catch {
    throw new SocialError('The signed funding transaction could not be verified.', 400);
  }
}

export async function verifyRingsQuoteReady(room: RingsRoom, rpc: URL) {
  const other = dealTermsLeg(room.terms, otherRingsSide(room.side));
  if (other.asset !== 'TOKEN') return;
  const mint = address(other.token.mint);
  const registry = await ringsConnection(rpc).getAccountInfo(
    new PublicKey(await getSplAssetRegistryAddress(mint)),
    'finalized'
  );
  if (
    !registry?.data.length ||
    registry.owner.toBase58() !== SHIELDED_POOL_PROGRAM_ID ||
    decodeSplAssetRegistry(registry.data).mint !== mint
  )
    throw new SocialError(
      'Wait for the launch token holder to fund first and complete Rings setup.',
      409
    );
}

export async function requireSafeRetry(
  connection: Pick<Connection, 'getSignatureStatus' | 'getBlockHeight' | 'isBlockhashValid'>,
  { blockhash, lastValidBlockHeight }: Pick<RingsFunding, 'blockhash' | 'lastValidBlockHeight'>,
  signature?: string
) {
  const status = async () =>
    signature
      ? (await connection.getSignatureStatus(signature, { searchTransactionHistory: true })).value
      : null;
  const first = await status();
  if (first?.confirmationStatus === 'finalized' && first.err) return;
  if (
    first ||
    BigInt(await connection.getBlockHeight('finalized')) <= BigInt(lastValidBlockHeight) ||
    (await connection.isBlockhashValid(blockhash, { commitment: 'confirmed' })).value ||
    (await status())
  ) {
    throw new SocialError(
      'The prior transaction may still be active. Check its status again before retrying.',
      409
    );
  }
}
