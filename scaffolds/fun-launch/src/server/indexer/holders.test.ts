import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { scanHolders } from './holders';

const mint = Keypair.generate().publicKey;
function mintAccount(supply: bigint) {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data
  );
  return { data, owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false };
}
/** The 40-byte slice the scan requests: owner then amount. */
function slice(owner: PublicKey, amount: bigint) {
  const data = Buffer.alloc(40);
  owner.toBuffer().copy(data, 0);
  data.writeBigUInt64LE(amount, 32);
  return data;
}

describe('holder scan', () => {
  it('reads every token account, groups by owner and leaves pool and custody balances out', async () => {
    const alice = Keypair.generate().publicKey,
      bob = Keypair.generate().publicKey,
      vault = Keypair.generate().publicKey;
    const accounts = [
      { pubkey: Keypair.generate().publicKey, account: { data: slice(alice, 300n) } },
      { pubkey: Keypair.generate().publicKey, account: { data: slice(alice, 200n) } },
      { pubkey: Keypair.generate().publicKey, account: { data: slice(bob, 100n) } },
      { pubkey: Keypair.generate().publicKey, account: { data: slice(bob, 0n) } },
      { pubkey: vault, account: { data: slice(Keypair.generate().publicKey, 400n) } },
    ];
    const rpc = {
      getAccountInfoAndContext: vi.fn(async () => ({
        context: { slot: 7 },
        value: mintAccount(1000n),
      })),
      getProgramAccounts: vi.fn(async () => ({ context: { slot: 9 }, value: accounts })),
    };
    const scan = await scanHolders(rpc as never, {
      mint: mint.toBase58(),
      excludedAccounts: [vault.toBase58()],
    });
    expect(scan).toMatchObject({ slot: 9, decimals: 6, supply: 1000n, excluded: 400n });
    expect([...scan.holders]).toEqual([
      [alice.toBase58(), 500n],
      [bob.toBase58(), 100n],
    ]);
    const [program, options] = rpc.getProgramAccounts.mock.calls[0] as unknown as [
      PublicKey,
      { minContextSlot: number; dataSlice: unknown; filters: unknown[] },
    ];
    expect(program.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(options).toMatchObject({
      minContextSlot: 7,
      dataSlice: { offset: 32, length: 40 },
      filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint.toBase58() } }],
    });
  });

  it('refuses a missing mint and an impossible excluded balance', async () => {
    const missing = {
      getAccountInfoAndContext: async () => ({ context: { slot: 1 }, value: null as unknown }),
      getProgramAccounts: vi.fn(),
    };
    await expect(
      scanHolders(missing as never, { mint: mint.toBase58(), excludedAccounts: [] })
    ).rejects.toThrow('Mint account unavailable');
    const vault = Keypair.generate().publicKey;
    const overdrawn = {
      getAccountInfoAndContext: async () => ({ context: { slot: 1 }, value: mintAccount(10n) }),
      getProgramAccounts: async () => ({
        context: { slot: 1 },
        value: [{ pubkey: vault, account: { data: slice(vault, 11n) } }],
      }),
    };
    await expect(
      scanHolders(overdrawn as never, {
        mint: mint.toBase58(),
        excludedAccounts: [vault.toBase58()],
      })
    ).rejects.toThrow('exceeds mint supply');
  });
});
