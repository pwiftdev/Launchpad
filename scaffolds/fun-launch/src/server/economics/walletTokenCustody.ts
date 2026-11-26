import { PublicKey, type Connection } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, unpackAccount } from '@solana/spl-token';
import type { WalletStore } from './walletStore';
import type { WalletJob } from './walletTypes';
import { HSOL_REWARD_MINT } from '@/lib/rewards';
import { isHsolMode } from '@/lib/feeModes';
import { isMskdMode } from '@/lib/launchModes';
import type { RegisteredCoin } from '../launchRegistry';

export async function assertPayoutTokenBacking(
  rpc: Connection,
  store: WalletStore,
  collector: PublicKey,
  job: WalletJob,
  coin: RegisteredCoin
) {
  const paysWxmr = isMskdMode(coin.mode) && job.kind === 'community_claim';
  const asset = paysWxmr
    ? job.details.assetMint
    : isHsolMode(coin.mode) && (job.kind.endsWith('_claim') || job.kind === 'holder_conversion')
      ? HSOL_REWARD_MINT
      : null;
  if (asset === null) return;
  if (typeof asset !== 'string' || (!paysWxmr && coin.quote_mint !== asset))
    throw new Error('Token payout has no immutable mint');
  const mint = new PublicKey(asset);
  const { liability, minimumSlot } = await store.tokenCustodyRequirement(
    job.network_genesis,
    collector.toBase58(),
    mint.toBase58()
  );
  const address = getAssociatedTokenAddressSync(mint, collector);
  const info = await rpc.getAccountInfoAndContext(address, {
    commitment: 'finalized',
    minContextSlot: minimumSlot,
  });
  const token = unpackAccount(address, info.value, TOKEN_PROGRAM_ID);
  if (
    !Number.isSafeInteger(info.context.slot) ||
    info.context.slot < minimumSlot ||
    !token.owner.equals(collector) ||
    !token.mint.equals(mint) ||
    !token.isInitialized ||
    token.isFrozen ||
    token.delegate !== null ||
    token.closeAuthority !== null ||
    liability < BigInt(job.lamports) ||
    token.amount < liability
  )
    throw new Error(`Collector ${paysWxmr ? 'wXMR' : 'hSOL'} does not cover funded rewards`);
}
