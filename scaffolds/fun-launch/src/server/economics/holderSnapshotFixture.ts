import { type AccountInfo, type Connection, PublicKey } from '@solana/web3.js';
import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { fixtureGenesis, fixtureWallet } from './financialFixtures';

export function snapshotFixture() {
  const mint = fixtureWallet().publicKey,
    owners = [fixtureWallet(), fixtureWallet()];
  const info = (data: Buffer): AccountInfo<Buffer> => ({
    data,
    owner: TOKEN_PROGRAM_ID,
    lamports: 2039280,
    executable: false,
    rentEpoch: 0,
  });
  const entries = owners.map((owner, index) => {
    const data = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode(
      {
        mint,
        owner: owner.publicKey,
        amount: BigInt(index === 0 ? 3 : 1),
        delegateOption: 0,
        delegate: PublicKey.default,
        state: 1,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      data
    );
    return { pubkey: fixtureWallet().publicKey, account: info(data) };
  });
  const mintData = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 4n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    mintData
  );
  const rpc = {
    getGenesisHash: async () => fixtureGenesis,
    getProgramAccounts: async () => ({ context: { slot: 1000 }, value: entries }),
    getAccountInfoAndContext: async () => ({ context: { slot: 1000 }, value: info(mintData) }),
    getBlockTime: async () => 7200,
  } as unknown as Connection;
  return { mint, owners, rpc, entries, mintData };
}
