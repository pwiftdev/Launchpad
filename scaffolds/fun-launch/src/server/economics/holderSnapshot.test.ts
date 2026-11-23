import { describe, expect, it } from 'vitest';

import { TOKEN_PROGRAM_ID, AccountLayout } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { allocateHolderSnapshot } from './feeLedger';
import { collectHolderSnapshot, assertHolderSnapshot } from './holderSnapshot';
import { fixtureGenesis } from './financialFixtures';
import { snapshotFixture } from './holderSnapshotFixture';

describe('complete finalized holder snapshot', () => {
  it('keeps program balances in the complete supply proof but excludes off-curve owners from direct wallet allocations', async () => {
    const test = snapshotFixture(),
      [owner] = PublicKey.findProgramAddressSync([Buffer.from('program-wallet')], test.mint);
    const entry = test.entries[1]!,
      decoded = AccountLayout.decode(entry.account.data);
    AccountLayout.encode({ ...decoded, owner }, entry.account.data);
    const snapshot = await collectHolderSnapshot(test.rpc, {
      networkGenesis: fixtureGenesis,
      mint: test.mint.toBase58(),
      excludedOwners: new Set(),
    });
    expect(snapshot.supply).toBe(4n);
    expect(snapshot.balances.reduce((sum, row) => sum + row.tokens, 0n)).toBe(4n);
    expect(snapshot.excluded.has(owner.toBase58())).toBe(true);
    expect(allocateHolderSnapshot(100n, snapshot).allocations).toEqual([
      { wallet: test.owners[0]!.publicKey.toBase58(), lamports: 100n },
    ]);
    expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
  });
  it('includes every token account, reconciles supply and excludes vaults only after proving completeness', async () => {
    const test = snapshotFixture();
    const snapshot = await collectHolderSnapshot(test.rpc, {
      networkGenesis: fixtureGenesis,
      mint: test.mint.toBase58(),
      excludedOwners: new Set([test.owners[1]!.publicKey.toBase58()]),
    });
    expect(snapshot.balances.reduce((sum, row) => sum + row.tokens, 0n)).toBe(4n);
    expect(snapshot.supply).toBe(4n);
    expect(() =>
      assertHolderSnapshot(snapshot, fixtureGenesis, test.mint.toBase58())
    ).not.toThrow();
    expect(() =>
      assertHolderSnapshot({ ...snapshot }, fixtureGenesis, test.mint.toBase58())
    ).toThrow('independently');
    test.entries.pop();
    await expect(
      collectHolderSnapshot(test.rpc, {
        networkGenesis: fixtureGenesis,
        mint: test.mint.toBase58(),
        excludedOwners: new Set(),
      })
    ).rejects.toThrow('Incomplete');
  });
  it('refuses mixed-bank reads and never marks a limited scan complete', async () => {
    const test = snapshotFixture();
    await expect(
      collectHolderSnapshot(test.rpc, {
        networkGenesis: fixtureGenesis,
        mint: test.mint.toBase58(),
        excludedOwners: new Set(),
        maximumAccounts: 1,
      })
    ).rejects.toThrow('capacity');
    test.rpc.getAccountInfoAndContext = async () => ({
      context: { slot: 1001 },
      value: {
        data: test.mintData,
        owner: TOKEN_PROGRAM_ID,
        lamports: 2039280,
        executable: false,
        rentEpoch: 0,
      },
    });
    await expect(
      collectHolderSnapshot(test.rpc, {
        networkGenesis: fixtureGenesis,
        mint: test.mint.toBase58(),
        excludedOwners: new Set(),
      })
    ).rejects.toThrow('same finalized bank');
  });
});
