import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { attestLaunchPreparation } from '@/server/launchPreparation';
import {
  pendingLaunchKey,
  pendingLaunchFor,
  savePendingLaunch,
  clearPendingLaunch,
  preparedLaunchMessage,
  submitPreparedLaunch,
  finishLaunchRegistration,
  checkPendingLaunch,
} from './launchRegistration';
const fetchMock = vi.fn();
const memory = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
};
export function launchFixture(walletSeed = 1, mintSeed = 2, networkSeed = 3) {
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(walletSeed)),
    mint = Keypair.fromSeed(new Uint8Array(32).fill(mintSeed)),
    genesis = new PublicKey(new Uint8Array(32).fill(networkSeed)).toBase58(),
    transaction = new Transaction({
      feePayer: wallet.publicKey,
      recentBlockhash: new PublicKey(new Uint8Array(32).fill(9)).toBase58(),
    }).add(
      SystemProgram.createAccount({
        fromPubkey: wallet.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports: 1,
        space: 82,
        programId: new PublicKey(new Uint8Array(32).fill(5)),
      })
    );
  const context = attestLaunchPreparation({
      transaction,
      mint: mint.publicKey.toBase58(),
      wallet: wallet.publicKey.toBase58(),
      genesis,
      preparedSlot: 50,
      lastValidBlockHeight: 100,
    }),
    message = Uint8Array.from(transaction.serializeMessage());
  transaction.partialSign(wallet, mint);
  return {
    wallet,
    mint,
    transaction,
    context,
    message,
    receipt: {
      mint: mint.publicKey.toBase58(),
      wallet: wallet.publicKey.toBase58(),
      name: 'Test',
      symbol: 'TEST',
      image: null as string | null,
      devBuyPercent: 0,
      mode: 'creator' as const,
      ...context,
    },
    signature: bs58.encode(transaction.signature!),
  };
}
beforeEach(() => {
  vi.stubEnv('ADMIN_SESSION_SECRET', 'launch-recovery-unit-secret-32-bytes-minimum');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it('persists the locally derived receipt BEFORE a relay that broadcasts then loses its response', async () => {
  const f = launchFixture(),
    storage = memory();
  fetchMock.mockImplementation(async () => {
    expect(pendingLaunchFor(f.receipt.wallet, f.context.genesis, storage)?.signature).toBe(
      f.signature
    );
    throw new Error('response lost after broadcast');
  });
  const result = await submitPreparedLaunch(
    { signed: f.transaction, expectedMessage: f.message, receipt: f.receipt },
    storage
  );
  expect(result.relayAccepted).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(pendingLaunchFor(f.receipt.wallet, f.context.genesis, storage)?.signature).toBe(
    f.signature
  );
  expect(pendingLaunchFor(f.receipt.wallet, f.context.genesis, storage)?.messageBase64).toBe(
    f.context.messageBase64
  );
});
it('recovers a Bond it. launch receipt after a lost relay response', async () => {
  const f = launchFixture(),
    storage = memory();
  fetchMock.mockRejectedValue(new Error('response lost after broadcast'));
  await submitPreparedLaunch(
    { signed: f.transaction, expectedMessage: f.message, receipt: { ...f.receipt, mode: 'bond' } },
    storage
  );
  const recovered = pendingLaunchFor(f.receipt.wallet, f.context.genesis, storage);
  expect(recovered?.mode).toBe('bond');
  expect(recovered?.signature).toBe(f.signature);
});
it('blocks relay when storage throws or silently fails, and never stores signed wire or keys', async () => {
  const f = launchFixture();
  for (const storage of [
    {
      ...memory(),
      setItem: () => {
        throw Error('quota');
      },
    },
    { ...memory(), setItem: () => {} },
  ])
    await expect(
      submitPreparedLaunch(
        { signed: f.transaction, expectedMessage: f.message, receipt: f.receipt },
        storage
      )
    ).rejects.toThrow('save');
  expect(fetchMock).not.toHaveBeenCalled();
  const storage = memory();
  savePendingLaunch(
    {
      ...f.receipt,
      signature: f.signature,
      secretKey: 'forbidden',
      signedTransaction: 'forbidden',
    } as typeof f.receipt & { signature: string },
    storage
  );
  const raw = storage.getItem(pendingLaunchKey(f.receipt.wallet, f.context.genesis))!;
  expect(raw).not.toContain('forbidden');
  expect(raw).not.toContain('secretKey');
  expect(raw).not.toContain('signedTransaction');
});
it('rejects changed wallet messages/missing mint signatures and never trusts a different relay signature', async () => {
  const altered = launchFixture();
  altered.transaction.recentBlockhash = PublicKey.default.toBase58();
  await expect(
    submitPreparedLaunch(
      { signed: altered.transaction, expectedMessage: altered.message, receipt: altered.receipt },
      memory()
    )
  ).rejects.toThrow('changed');
  const missing = launchFixture();
  missing.transaction.signatures[1]!.signature = null;
  await expect(
    submitPreparedLaunch(
      { signed: missing.transaction, expectedMessage: missing.message, receipt: missing.receipt },
      memory()
    )
  ).rejects.toThrow('signature');
  expect(fetchMock).not.toHaveBeenCalled();
  const f = launchFixture(),
    storage = memory();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ signature: bs58.encode(new Uint8Array(64).fill(8)) }), {
      status: 200,
    })
  );
  const result = await submitPreparedLaunch(
    { signed: f.transaction, expectedMessage: f.message, receipt: f.receipt },
    storage
  );
  expect(result.relayAccepted).toBe(false);
  expect(result.receipt.signature).toBe(f.signature);
});
it('isolates wallet/network receipts and only clears the specified scope', () => {
  const storage = memory(),
    a = launchFixture(),
    b = launchFixture(4, 5, 3),
    c = launchFixture(1, 6, 7);
  for (const f of [a, b, c]) savePendingLaunch({ ...f.receipt, signature: f.signature }, storage);
  clearPendingLaunch(a.receipt.mint, a.receipt.wallet, a.context.genesis, storage);
  expect(pendingLaunchFor(a.receipt.wallet, a.context.genesis, storage)).toBeNull();
  for (const f of [b, c])
    expect(pendingLaunchFor(f.receipt.wallet, f.context.genesis, storage)?.signature).toBe(
      f.signature
    );
  const conflict = launchFixture(4, 8, 3);
  expect(() =>
    savePendingLaunch({ ...conflict.receipt, signature: conflict.signature }, storage)
  ).toThrow('saved launch');
});
it('keeps legacy receipts held and refuses expiry-based clearing without preparation context', async () => {
  const f = launchFixture(),
    storage = memory();
  storage.setItem(
    'rinsed.pendingLaunch.v1',
    JSON.stringify({
      mint: f.receipt.mint,
      wallet: f.receipt.wallet,
      name: 'Legacy',
      symbol: 'OLD',
      image: null,
      devBuyPercent: 0,
      mode: 'creator',
      signature: f.signature,
    })
  );
  const legacy = pendingLaunchFor(f.receipt.wallet, f.context.genesis, storage)!;
  expect(legacy).not.toBeNull();
  expect(await checkPendingLaunch(legacy)).toEqual({ safeToRetry: false, state: 'pending' });
  expect(fetchMock).not.toHaveBeenCalled();
});
it('clears an exact scoped receipt despite malformed unrelated legacy storage', () => {
  const f = launchFixture(),
    storage = memory();
  savePendingLaunch({ ...f.receipt, signature: f.signature }, storage);
  storage.setItem('rinsed.pendingLaunch.v1', '{broken');
  clearPendingLaunch(f.receipt.mint, f.receipt.wallet, f.context.genesis, storage);
  expect(storage.getItem(pendingLaunchKey(f.receipt.wallet, f.context.genesis))).toBeNull();
  expect(storage.getItem('rinsed.pendingLaunch.v1')).toBe('{broken');
});
it('does not claim a saved receipt was cleared when browser storage is unavailable', () => {
  const f = launchFixture();
  expect(() =>
    clearPendingLaunch(f.receipt.mint, f.receipt.wallet, f.context.genesis, {
      ...memory(),
      getItem: () => {
        throw new Error('storage unavailable');
      },
    })
  ).toThrow('storage unavailable');
});
it('pins the prepared public message/network and clears only after exact registered identity', async () => {
  const f = launchFixture(),
    storage = memory();
  expect(preparedLaunchMessage(f.transaction, f.context, f.context.genesis).message).toEqual(
    f.message
  );
  expect(() =>
    preparedLaunchMessage(f.transaction, f.context, PublicKey.default.toBase58())
  ).toThrow('network');
  vi.stubGlobal('localStorage', storage);
  savePendingLaunch({ ...f.receipt, signature: f.signature }, storage);
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        status: 'registered',
        mint: f.receipt.mint,
        genesis: PublicKey.default.toBase58(),
        mode: 'creator',
        originalDeployer: f.receipt.wallet,
      })
    )
  );
  await expect(
    finishLaunchRegistration(f.receipt.mint, f.signature, 1000, f.receipt)
  ).rejects.toThrow('identity');
  expect(pendingLaunchFor(f.receipt.wallet, f.context.genesis, storage)).not.toBeNull();
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        status: 'registered',
        mint: f.receipt.mint,
        genesis: f.context.genesis,
        mode: 'creator',
        originalDeployer: f.receipt.wallet,
      })
    )
  );
  await finishLaunchRegistration(f.receipt.mint, f.signature, 1000, f.receipt);
  expect(pendingLaunchFor(f.receipt.wallet, f.context.genesis, storage)).toBeNull();
});
