import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { vaultAddresses, claimPlatformInstruction } from '@/lib/vault/client';
import { FinalizedVerifier } from './chainEvidence';
const f = vi.hoisted(() => ({ coin: vi.fn(), config: vi.fn(), balances: vi.fn() }));
vi.mock('../launchRegistry', () => ({ registeredCoin: f.coin, registeredConfig: f.config }));
import { preparePlatformWithdrawal } from './platformWithdrawal';
const program = Keypair.generate().publicKey,
  mint = Keypair.generate().publicKey,
  treasury = Keypair.generate().publicKey,
  config = Keypair.generate().publicKey,
  pool = Keypair.generate().publicKey,
  creator = Keypair.generate().publicKey;
const addresses = vaultAddresses(program, mint),
  rpc = new Connection('http://127.0.0.1:8899');
let settings: Buffer, coin: Buffer;
beforeEach(() => {
  vi.restoreAllMocks();
  settings = Buffer.alloc(107);
  settings.write('RSET0001');
  settings[8] = 1;
  treasury.toBuffer().copy(settings, 75);
  coin = Buffer.alloc(347);
  coin.write('RCOIN001');
  coin[8] = 1;
  mint.toBuffer().copy(coin, 11);
  pool.toBuffer().copy(coin, 43);
  config.toBuffer().copy(coin, 75);
  creator.toBuffer().copy(coin, 107);
  coin.writeBigInt64LE(900n, 139);
  coin.writeBigUInt64LE(100n, 171);
  Buffer.alloc(32, 1).copy(coin, 291);
  f.coin.mockResolvedValue({
    policy_version: 'rinse-v1',
    dbc_pool: pool.toBase58(),
    config_key: config.toBase58(),
    original_deployer: creator.toBase58(),
    mode: 'creator',
    activation_point: '900',
  });
  f.config.mockResolvedValue({
    policy_version: 'rinse-v1',
    expected_leftover_receiver: treasury.toBase58(),
    config_digest: Buffer.alloc(32, 1).toString('hex'),
  });
  f.balances.mockResolvedValue([
    { bucket: 'platform', funded: '120', spent: '20', reserved: '30' },
  ]);
  vi.spyOn(rpc, 'getGenesisHash').mockResolvedValue('genesis');
  vi.spyOn(rpc, 'getSlot').mockResolvedValue(1000);
  vi.spyOn(rpc, 'getBlockTime').mockResolvedValue(1000);
  vi.spyOn(rpc, 'getLatestBlockhash').mockResolvedValue({
    blockhash: PublicKey.default.toBase58(),
    lastValidBlockHeight: 1100,
  });
  vi.spyOn(rpc, 'getMultipleAccountsInfoAndContext').mockImplementation(async () => ({
    context: { slot: 1000 },
    value: [
      {
        owner: PublicKey.default,
        data: Buffer.alloc(0),
        lamports: 1,
        executable: true,
        rentEpoch: 0,
      },
      { owner: program, data: settings, lamports: 1, executable: false, rentEpoch: 0 },
      { owner: program, data: coin, lamports: 1000, executable: false, rentEpoch: 0 },
    ],
  }));
});
afterEach(() => vi.restoreAllMocks());
async function prepare(amount = 70n) {
  return preparePlatformWithdrawal({
    rpc,
    store: { balances: f.balances },
    programId: program,
    mint,
    networkGenesis: 'genesis',
    amount,
    clock: await new FinalizedVerifier(rpc, 'genesis').clock(),
  });
}
describe('private platform withdrawal preparation', () => {
  it('uses only the immutable treasury signer/recipient and exact native claim ABI', async () => {
    const plan = await prepare(),
      tx = Transaction.from(Buffer.from(plan.transactionBase64, 'base64'));
    expect(tx.feePayer?.equals(treasury)).toBe(true);
    expect(tx.signatures.map((value) => value.publicKey.toBase58())).toEqual([treasury.toBase58()]);
    expect(tx.instructions).toHaveLength(1);
    expect(tx.instructions[0]?.data).toEqual(
      claimPlatformInstruction(program, mint, treasury, 70n).data
    );
    expect(plan).toMatchObject({
      kind: 'platform_claim',
      lamports: 70n,
      recipient: treasury.toBase58(),
      expectation: { vault: addresses.coin.toBase58(), effect: 'sol_claim' },
    });
  });
  it('rejects native/SQL budget drift and funds already reserved for another withdrawal', async () => {
    await expect(prepare(71n)).rejects.toThrow('Reconcile');
    f.balances.mockResolvedValue([
      { bucket: 'platform', funded: '119', spent: '20', reserved: '0' },
    ]);
    await expect(prepare(1n)).rejects.toThrow('Reconcile');
  });
  it('rejects treasury substitution and a native identity/config digest mismatch', async () => {
    Keypair.generate().publicKey.toBuffer().copy(settings, 75);
    await expect(prepare()).rejects.toThrow('recipient');
    treasury.toBuffer().copy(settings, 75);
    coin[291] = 2;
    await expect(prepare()).rejects.toThrow('identity');
  });
});
