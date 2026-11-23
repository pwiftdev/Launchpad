import { describe, expect, it } from 'vitest';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  createBurnCheckedInstruction,
  createCloseAccountInstruction,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk';
import bs58 from 'bs58';
import { fixtureGenesis, fixtureWallet, transactionFixture } from './financialFixtures';
import { messageDigest } from './chainEvidence';
import {
  assertVerifiedWalletEffect,
  verifyWalletEffect,
  WALLET_MEMO_PROGRAM,
} from './walletEvidence';
import type { WalletEffectFacts, WalletJob } from './walletTypes';

const memo = 'RINSED:00000000-0000-4000-8000-000000000000';
const memoIx = () =>
  new TransactionInstruction({ programId: WALLET_MEMO_PROGRAM, keys: [], data: Buffer.from(memo) });
function jobFor(
  t: ReturnType<typeof transactionFixture>,
  kind: WalletJob['kind'],
  extras: Partial<WalletJob> = {}
): WalletJob {
  Object.assign(t.rpc, {
    getBlockSignatures: async () => ({ signatures: ['previous', t.signature, 'later'] }),
  });
  return {
    id: '00000000-0000-4000-8000-000000000000',
    network_genesis: fixtureGenesis,
    mint: fixtureWallet().publicKey.toBase58(),
    kind,
    intent_key: 'test',
    bucket: null,
    recipient: null,
    epoch: null,
    lamports: '0',
    status: 'submitted',
    transaction_base64: t.tx.serialize().toString('base64'),
    message_digest: messageDigest(t.tx.serializeMessage()),
    prepared_slot: '900',
    last_valid_block_height: '2000',
    signature: t.signature,
    finalized_slot: null,
    received_lamports: '0',
    burned_tokens: '0',
    details: {},
    expectations: {
      collector: t.payer.publicKey.toBase58(),
      pool: fixtureWallet().publicKey.toBase58(),
      memo,
      maximumFeeLamports: '10000',
      operatingCostLamports: '5000000',
    },
    ...extras,
  };
}
function settlement(kind: 'collect' | 'buyback', donation = 0) {
  const payer = fixtureWallet(),
    mint = fixtureWallet().publicKey,
    quote = fixtureWallet().publicKey,
    token = fixtureWallet().publicKey,
    quoteVault = fixtureWallet().publicKey,
    baseVault = fixtureWallet().publicKey;
  const dex = new TransactionInstruction({
    programId: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
    keys: [quote, token, quoteVault, baseVault].map((pubkey) => ({
      pubkey,
      isSigner: false,
      isWritable: true,
    })),
    data: Buffer.from([42]),
  });
  const t = transactionFixture(
    [
      dex,
      ...(kind === 'buyback'
        ? [createBurnCheckedInstruction(token, mint, payer.publicKey, 100n, 6)]
        : []),
      createCloseAccountInstruction(quote, payer.publicKey, payer.publicKey),
      memoIx(),
    ],
    payer
  );
  const received = 500000,
    spent = 400000,
    rent = 2039280,
    preQuote = donation + rent;
  t.balance(
    payer.publicKey.toBase58(),
    100000000,
    100000000 + (kind === 'collect' ? received : -spent) + preQuote - rent - 5000
  );
  const quoteIndex = t.balance(quote.toBase58(), preQuote, 0),
    tokenIndex = t.balance(token.toBase58(), 0, rent),
    vaultIndex = t.accounts.findIndex((k) => k.equals(quoteVault)),
    baseIndex = t.accounts.findIndex((k) => k.equals(baseVault));
  const tokenBalance = (accountIndex: number, mint: PublicKey, amount: string) => ({
    accountIndex,
    mint: mint.toBase58(),
    owner: payer.publicKey.toBase58(),
    uiTokenAmount: {
      amount,
      decimals: mint.equals(NATIVE_MINT) ? 9 : 6,
      uiAmount: 0,
      uiAmountString: '0',
    },
  });
  t.response.meta!.preTokenBalances = [
    tokenBalance(vaultIndex, NATIVE_MINT, '99999999'),
    tokenBalance(baseIndex, mint, '99999999'),
    tokenBalance(quoteIndex, NATIVE_MINT, donation.toString()),
  ];
  t.response.meta!.postTokenBalances = [
    tokenBalance(
      vaultIndex,
      NATIVE_MINT,
      (99999999 + (kind === 'collect' ? -received : spent)).toString()
    ),
    tokenBalance(baseIndex, mint, kind === 'collect' ? '99999999' : '99999899'),
    tokenBalance(tokenIndex, mint, '0'),
  ];
  const transfer = (source: PublicKey, destination: PublicKey, amount: bigint) => {
    const data = Buffer.alloc(9);
    data[0] = 3;
    data.writeBigUInt64LE(amount, 1);
    return {
      programIdIndex: t.accounts.findIndex((k) => k.equals(TOKEN_PROGRAM_ID)),
      accounts: [
        t.accounts.findIndex((k) => k.equals(source)),
        t.accounts.findIndex((k) => k.equals(destination)),
        0,
      ],
      data: bs58.encode(data),
    };
  };
  t.response.meta!.innerInstructions = [
    {
      index: 0,
      instructions:
        kind === 'collect'
          ? [transfer(quoteVault, quote, BigInt(received))]
          : [transfer(quote, quoteVault, BigInt(spent)), transfer(baseVault, token, 100n)],
    },
  ];
  const job = jobFor(t, kind, {
    mint: mint.toBase58(),
    lamports: kind === 'collect' ? received.toString() : spent.toString(),
  });
  Object.assign(job.expectations, {
    route: 'dbc',
    quoteAta: quote.toBase58(),
    tokenAta: token.toBase58(),
    sourceQuoteVault: quoteVault.toBase58(),
    sourceTokenVault: baseVault.toBase58(),
    expectedLamports: received.toString(),
    maximumSpendLamports: '500000',
    burnTokens: '100',
    instruction: {
      program: dex.programId.toBase58(),
      accounts: dex.keys.map((k) => k.pubkey.toBase58()),
      dataBase64: dex.data.toString('base64'),
    },
  });
  return { t, job, received, spent };
}
describe('ordinary-wallet finalized cash and burn evidence', () => {
  it('requires independent proof and preserves canonical same-slot ordering', async () => {
    const { t, job } = settlement('collect');
    const facts = await verifyWalletEffect(t.rpc, job, await t.evidence());
    expect(facts.receivedLamports).toBe(500000n);
    expect(facts.transactionIndex).toBe(1);
    expect(facts.slotSignatures?.[2]).toBe('later');
    expect(() => assertVerifiedWalletEffect(facts)).not.toThrow();
    expect(() => assertVerifiedWalletEffect({ ...facts })).toThrow('independently');
    await expect(verifyWalletEffect(t.rpc, job, { ...(await t.evidence()) })).rejects.toThrow(
      'independently'
    );
  });
  it('excludes pre-existing wrapped SOL and rent from collected fees', async () => {
    const { t, job, received } = settlement('collect', 7300000);
    expect((await verifyWalletEffect(t.rpc, job, await t.evidence())).receivedLamports).toBe(
      BigInt(received)
    );
    job.expectations.expectedLamports = (received + 7300000).toString();
    await expect(verifyWalletEffect(t.rpc, job, await t.evidence())).rejects.toThrow(
      'reserved fee'
    );
  });
  it('proves exact purchase plus burn and debits actual spend instead of the maximum', async () => {
    const { t, job, spent } = settlement('buyback', 900000);
    const effect = await verifyWalletEffect(t.rpc, job, await t.evidence());
    expect(effect.burnedTokens).toBe(100n);
    expect(effect.collectorDebitLamports).toBe(BigInt(spent));
    t.response.meta!.innerInstructions![0]!.instructions.pop();
    await expect(verifyWalletEffect(t.rpc, job, await t.evidence())).rejects.toThrow(
      'purchase and burn'
    );
  });
  it('rejects mismatched payout cash and accepts an exact self-transfer once', async () => {
    const payer = fixtureWallet(),
      recipient = fixtureWallet().publicKey;
    const t = transactionFixture(
      [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: recipient,
          lamports: 800000,
        }),
        memoIx(),
      ],
      payer
    );
    t.balance(payer.publicKey.toBase58(), 10000000, 9195000);
    t.balance(recipient.toBase58(), 0, 800000);
    const job = jobFor(t, 'creator_claim', { recipient: recipient.toBase58(), lamports: '800000' });
    Object.assign(job.expectations, { recipient: job.recipient, expectedLamports: job.lamports });
    expect((await verifyWalletEffect(t.rpc, job, await t.evidence())).paidLamports).toBe(800000n);
    t.balance(recipient.toBase58(), 0, 799999);
    await expect(verifyWalletEffect(t.rpc, job, await t.evidence())).rejects.toThrow('cash');
    const self = transactionFixture(
      [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: payer.publicKey,
          lamports: 800000,
        }),
        memoIx(),
      ],
      payer
    );
    self.balance(payer.publicKey.toBase58(), 10000000, 9995000);
    const selfJob = jobFor(self, 'creator_claim', {
      recipient: payer.publicKey.toBase58(),
      lamports: '800000',
    });
    Object.assign(selfJob.expectations, {
      recipient: selfJob.recipient,
      expectedLamports: selfJob.lamports,
    });
    expect((await verifyWalletEffect(self.rpc, selfJob, await self.evidence())).paidLamports).toBe(
      800000n
    );
  });
  it('refuses missing canonical block evidence and forged effect objects', async () => {
    const { t, job } = settlement('collect');
    Object.assign(t.rpc, {
      getBlockSignatures: async (): Promise<{ signatures: string[] }> => ({ signatures: [] }),
    });
    await expect(verifyWalletEffect(t.rpc, job, await t.evidence())).rejects.toThrow(
      'execution order'
    );
    expect(() => assertVerifiedWalletEffect({} as WalletEffectFacts)).toThrow('independently');
  });
});
