import { createHash } from 'node:crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, unpackAccount, unpackMint } from '@solana/spl-token';

const verified = new WeakSet<object>();
export type FinalizedHolderSnapshot = {
  complete: true;
  finalized: true;
  networkGenesis: string;
  mint: string;
  slot: number;
  blockTime: number;
  supply: bigint;
  digest: string;
  excluded: ReadonlySet<string>;
  balances: { wallet: string; tokens: bigint }[];
};
export function assertHolderSnapshot(
  snapshot: FinalizedHolderSnapshot,
  network: string,
  mint: string
): void {
  if (!verified.has(snapshot) || snapshot.networkGenesis !== network || snapshot.mint !== mint)
    throw new Error('A complete independently verified finalized holder snapshot is required');
}

/** Full SPL account scan, not getTokenLargestAccounts. Same-bank mint supply must reconcile exactly. */
export async function collectHolderSnapshot(
  rpc: Connection,
  input: {
    networkGenesis: string;
    mint: string;
    excludedOwners: ReadonlySet<string>;
    excludedTokenAccounts?: ReadonlySet<string>;
    maximumAccounts?: number;
  }
): Promise<FinalizedHolderSnapshot> {
  if ((await rpc.getGenesisHash()) !== input.networkGenesis)
    throw new Error('Snapshot RPC network mismatch');
  const mintKey = new PublicKey(input.mint);
  for (let attempt = 0; attempt < 4; attempt++) {
    const [response, mintResponse] = await Promise.all([
      rpc.getProgramAccounts(TOKEN_PROGRAM_ID, {
        commitment: 'finalized',
        withContext: true,
        filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: input.mint } }],
      }),
      rpc.getAccountInfoAndContext(mintKey, { commitment: 'finalized' }),
    ]);
    if (response.value.length > (input.maximumAccounts ?? 100_000))
      throw new Error('Holder snapshot exceeds configured worker capacity');
    if (mintResponse.context.slot !== response.context.slot) continue;
    if (!mintResponse.value) throw new Error('Snapshot mint does not exist');
    const mint = unpackMint(mintKey, mintResponse.value, TOKEN_PROGRAM_ID);
    if (mint.mintAuthority !== null || mint.freezeAuthority !== null || mint.decimals !== 6)
      throw new Error('Holder snapshot requires the reviewed immutable SPL mint policy');
    let scanned = 0n;
    const seen = new Set<string>();
    const accounts = response.value
      .map(({ pubkey, account }) => {
        const address = pubkey.toBase58();
        if (seen.has(address)) throw new Error('Duplicate holder account in RPC snapshot');
        seen.add(address);
        const decoded = unpackAccount(pubkey, account, TOKEN_PROGRAM_ID);
        if (!decoded.mint.equals(mintKey) || !decoded.isInitialized)
          throw new Error('Invalid holder account');
        scanned += decoded.amount;
        return { address, wallet: decoded.owner.toBase58(), tokens: decoded.amount };
      })
      .sort((a, b) => a.address.localeCompare(b.address, 'en'));
    if (scanned !== mint.supply)
      throw new Error('Incomplete holder scan or inconsistent mint supply');
    const blockTime = await rpc.getBlockTime(response.context.slot);
    if (!Number.isSafeInteger(blockTime) || blockTime! < 0)
      throw new Error('Finalized snapshot time unavailable');
    const excluded = new Set(input.excludedOwners);
    // Program-address holdings stay in the complete supply proof, then are excluded from this direct wallet claim path.
    for (const account of accounts)
      if (!PublicKey.isOnCurve(new PublicKey(account.wallet).toBytes()))
        excluded.add(account.wallet);
    const balances = accounts
      .filter((account) => !input.excludedTokenAccounts?.has(account.address))
      .map(({ wallet, tokens }) => ({ wallet, tokens }));
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          network: input.networkGenesis,
          mint: input.mint,
          slot: response.context.slot,
          supply: mint.supply.toString(),
          accounts: accounts.map((account) => [
            account.address,
            account.wallet,
            account.tokens.toString(),
          ]),
          excludedOwners: [...excluded].sort(),
          excludedTokenAccounts: [...(input.excludedTokenAccounts ?? [])].sort(),
        })
      )
      .digest('hex');
    const snapshot: FinalizedHolderSnapshot = {
      complete: true,
      finalized: true,
      networkGenesis: input.networkGenesis,
      mint: input.mint,
      slot: response.context.slot,
      blockTime: blockTime!,
      supply: mint.supply,
      digest,
      excluded,
      balances,
    };
    verified.add(snapshot);
    return snapshot;
  }
  throw new Error('Could not obtain token accounts and mint supply at the same finalized bank');
}
