import { describe, it, expect } from 'vitest';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { claimCreatorInstruction } from './client';
import { reviewClaimTransaction } from './claimTransaction';

describe('wallet-side claim review', () => {
  const wallet = Keypair.generate().publicKey,
    program = Keypair.generate().publicKey,
    mint = Keypair.generate().publicKey;
  const expected = claimCreatorInstruction(program, mint, wallet, 100n);
  const base = () =>
    new Transaction({ feePayer: wallet, recentBlockhash: PublicKey.default.toBase58() });
  const encode = (tx: Transaction) =>
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  it('accepts the exact recipient, amount, program and bounded compute budget', () => {
    const tx = base().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), expected);
    expect(reviewClaimTransaction(encode(tx), expected, wallet).instructions).toHaveLength(2);
  });
  it('rejects hidden transfers, changed rewards and priority-fee instructions', () => {
    const transfer = SystemProgram.transfer({
      fromPubkey: wallet,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    });
    const changed = claimCreatorInstruction(program, mint, wallet, 101n);
    for (const tx of [
      base().add(expected, transfer),
      base().add(changed),
      base().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }), expected),
      base().add(expected, expected),
    ])
      expect(() => reviewClaimTransaction(encode(tx), expected, wallet)).toThrow();
  });
  it('rejects another payer or beneficiary', () => {
    const other = Keypair.generate().publicKey;
    expect(() =>
      reviewClaimTransaction(
        encode(base().add(claimCreatorInstruction(program, mint, other, 100n))),
        expected,
        wallet
      )
    ).toThrow();
    const tx = base().add(expected);
    tx.feePayer = other;
    expect(() => reviewClaimTransaction(encode(tx), expected, wallet)).toThrow();
  });
});
