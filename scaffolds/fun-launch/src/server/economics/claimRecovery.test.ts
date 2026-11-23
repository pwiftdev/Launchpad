import { describe, it, expect } from 'vitest';
import { claimPlatformInstruction, vaultAddresses } from '@/lib/vault/client';
import {
  fixtureGenesis,
  fixtureWallet,
  transactionFixture,
  unsignedTransaction,
} from './financialFixtures';
import { messageDigest } from './chainEvidence';
import { verifyUnsignedClaimExpiry } from './claimRecovery';
import type { FinancialJob } from './financialStore';

describe('unsigned treasury recovery', () => {
  it('requires the fixed native treasury and reads the actual platform budget before renewal', async () => {
    const program = fixtureWallet().publicKey,
      mint = fixtureWallet().publicKey,
      treasury = fixtureWallet(),
      a = vaultAddresses(program, mint);
    const ix = claimPlatformInstruction(program, mint, treasury.publicKey, 50n),
      test = transactionFixture([ix], treasury);
    const job = {
      id: 'treasury',
      network_genesis: fixtureGenesis,
      mint: mint.toBase58(),
      kind: 'platform_claim',
      status: 'prepared',
      signature: null,
      recipient: treasury.publicKey.toBase58(),
      transaction_base64: unsignedTransaction(test.tx),
      message_digest: messageDigest(test.tx.serializeMessage()),
      last_valid_block_height: '900',
    } as FinancialJob;
    const coin = Buffer.alloc(347);
    coin.write('RCOIN001');
    coin[8] = 1;
    mint.toBuffer().copy(coin, 11);
    coin.writeBigUInt64LE(50n, 171);
    const settings = Buffer.alloc(107);
    settings.write('RSET0001');
    settings[8] = 1;
    treasury.publicKey.toBuffer().copy(settings, 75);
    test.rpc.getBlockHeight = async () => 1001;
    test.rpc.isBlockhashValid = async () => ({ context: { slot: 1000 }, value: false });
    test.rpc.getAccountInfoAndContext = async (key) => ({
      context: { slot: 1000 },
      value: {
        owner: program,
        data: key.equals(a.settings) ? settings : coin,
        lamports: 2039280,
        executable: false,
        rentEpoch: 0,
      },
    });
    expect(
      (await verifyUnsignedClaimExpiry(test.rpc, job, program.toBase58())).platformBudget
    ).toBe(50n);
    await expect(
      verifyUnsignedClaimExpiry(
        test.rpc,
        { ...job, recipient: fixtureWallet().publicKey.toBase58() },
        program.toBase58()
      )
    ).rejects.toThrow('Treasury');
    await expect(
      verifyUnsignedClaimExpiry(
        test.rpc,
        { ...job, signature: test.signature, status: 'manual_review' },
        program.toBase58()
      )
    ).rejects.toThrow('unsigned');
  });
});
