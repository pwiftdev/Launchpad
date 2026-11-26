// Full holder list for one coin: every token account for the mint, grouped by owner.
import { PublicKey, type Connection } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackMint } from '@solana/spl-token';
import bs58 from 'bs58';

export type HolderRpc = Pick<Connection, 'getAccountInfoAndContext' | 'getProgramAccounts'>;

/** Token account layout: mint 0..32, owner 32..64, amount 64..72. Only owner and amount are read. */
const SLICE = { offset: 32, length: 40 };

export async function scanHolders(
  rpc: HolderRpc,
  input: { mint: string; excludedAccounts: string[] }
) {
  const mint = new PublicKey(input.mint);
  const mintInfo = await rpc.getAccountInfoAndContext(mint, 'confirmed');
  const info = mintInfo.value;
  if (!info || (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)))
    throw new Error('Mint account unavailable');
  const data = unpackMint(mint, info, info.owner);
  const classic = info.owner.equals(TOKEN_PROGRAM_ID);
  const accounts = await rpc.getProgramAccounts(info.owner, {
    commitment: 'confirmed',
    withContext: true,
    dataSlice: SLICE,
    minContextSlot: mintInfo.context.slot,
    // Token-2022 accounts carry extensions, so only the classic program can filter by size.
    filters: [
      ...(classic ? [{ dataSize: 165 }] : []),
      { memcmp: { offset: 0, bytes: mint.toBase58() } },
    ],
  });
  const excluded = new Set(input.excludedAccounts);
  const holders = new Map<string, bigint>();
  let excludedRaw = 0n;
  for (const { pubkey, account } of accounts.value) {
    const slice = account.data;
    if (slice.length < SLICE.length) throw new Error('Unexpected token account layout');
    const amount = slice.readBigUInt64LE(32);
    if (amount === 0n) continue;
    if (excluded.has(pubkey.toBase58())) {
      excludedRaw += amount;
      continue;
    }
    const owner = bs58.encode(slice.subarray(0, 32));
    holders.set(owner, (holders.get(owner) ?? 0n) + amount);
  }
  if (excludedRaw > data.supply) throw new Error('Excluded balance exceeds mint supply');
  return {
    slot: accounts.context.slot,
    decimals: data.decimals,
    supply: data.supply,
    excluded: excludedRaw,
    holders,
  };
}
