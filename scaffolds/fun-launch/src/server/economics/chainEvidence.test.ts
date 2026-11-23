import { describe, expect, it } from 'vitest';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  FinalizedVerifier,
  assertFinalizedEvidence,
  lamportDelta,
  messageDigest,
  requireInstruction,
  validateSignedTransaction,
  netClaimCredit,
} from './chainEvidence';
import { fixtureGenesis, fixtureWallet, transactionFixture } from './financialFixtures';

describe('finalized financial evidence', () => {
  it('accounts for transfer/allocate/assign marker rent without treating unrelated transfers as claim payouts', async () => {
    const wallet = fixtureWallet(),
      marker = fixtureWallet().publicKey,
      other = fixtureWallet().publicKey;
    const test = transactionFixture(
      [
        new TransactionInstruction({
          programId: fixtureWallet().publicKey,
          keys: [
            { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
            { pubkey: marker, isSigner: false, isWritable: true },
            { pubkey: other, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: Buffer.alloc(1),
        }),
      ],
      wallet
    );
    const rent = 1461600n,
      reward = 762051n,
      transfer = Buffer.alloc(12);
    transfer.writeUInt32LE(2);
    transfer.writeBigUInt64LE(rent, 4);
    test.balance(
      wallet.publicKey.toBase58(),
      10_000_000,
      10_000_000 + Number(reward - rent) - 5000
    );
    test.response.meta!.innerInstructions = [
      {
        index: 0,
        instructions: [
          {
            programIdIndex: test.accounts.findIndex((key) => key.equals(SystemProgram.programId)),
            accounts: [0, test.accounts.findIndex((key) => key.equals(marker))],
            data: bs58.encode(transfer),
          },
        ],
      },
    ];
    const evidence = await test.evidence();
    expect(netClaimCredit(evidence, wallet.publicKey.toBase58(), marker.toBase58())).toBe(reward);
    expect(netClaimCredit(evidence, wallet.publicKey.toBase58(), other.toBase58())).toBe(
      reward - rent
    );
    expect(netClaimCredit(evidence, wallet.publicKey.toBase58())).toBe(reward - rent);
  });
  it('rejects untrusted objects, wrong networks, nonfinalized and changed messages', async () => {
    const destination = fixtureWallet().publicKey,
      payer = fixtureWallet();
    const test = transactionFixture(
      [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: destination,
          lamports: 100,
        }),
      ],
      payer
    );
    await expect(
      new FinalizedVerifier(test.rpc, 'wrong-network').transaction(test.signature)
    ).rejects.toThrow('network');
    await expect(
      new FinalizedVerifier(test.rpc, fixtureGenesis).transaction(test.signature, 'f'.repeat(64))
    ).rejects.toThrow('message');
    expect(() => assertFinalizedEvidence({ ...test.response } as never)).toThrow('independently');
    const evidence = await test.evidence();
    expect(evidence.signature).toBe(test.signature);
    expect(() =>
      requireInstruction(evidence, {
        program: SystemProgram.programId.toBase58(),
        accounts: [],
        data: Buffer.alloc(0),
      })
    ).toThrow();
    test.response.meta!.err = { InstructionError: [0, 'InvalidArgument'] };
    await expect(test.evidence()).rejects.toThrow('finalized');
  });
  it('requires every signer to sign the exact prepared transaction', () => {
    const payer = fixtureWallet(),
      destination = fixtureWallet().publicKey;
    const test = transactionFixture(
      [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: destination,
          lamports: 100,
        }),
      ],
      payer
    );
    const hash = messageDigest(test.tx.serializeMessage());
    const base64 = test.tx.serialize().toString('base64');
    expect(validateSignedTransaction(base64, hash).signature).toBe(test.signature);
    expect(() => validateSignedTransaction(base64, 'e'.repeat(64))).toThrow('changed');
    test.tx.signatures[0]!.signature = Buffer.alloc(64);
    expect(() =>
      validateSignedTransaction(
        test.tx.serialize({ verifySignatures: false }).toString('base64'),
        hash
      )
    ).toThrow('signer');
  });
  it('refuses rounded numeric lamport balances instead of silently truncating them', async () => {
    const payer = fixtureWallet(),
      program = fixtureWallet().publicKey;
    const test = transactionFixture(
      [new TransactionInstruction({ programId: program, keys: [], data: Buffer.alloc(1) })],
      payer
    );
    const evidence = await test.evidence();
    test.response.meta!.preBalances[0] = Number.MAX_SAFE_INTEGER + 1;
    expect(() => lamportDelta(evidence, payer.publicKey.toBase58())).toThrow('Unsafe');
    expect(() => lamportDelta(evidence, PublicKey.default.toBase58())).toThrow('not part');
  });
});
