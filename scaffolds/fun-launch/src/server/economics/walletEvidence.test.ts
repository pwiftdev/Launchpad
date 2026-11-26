import { describe, expect, it } from 'vitest';
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  createBurnCheckedInstruction,
  createCloseAccountInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk';
import bs58 from 'bs58';
import { HSOL_REWARD_MINT } from '@/lib/rewards';
import { HSOL_BRIDGE_POOL } from './walletMskdPolicy';
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

it('reconciles exact finalized SOL input and actual wXMR output before funding holders', async () => {
  const payer = fixtureWallet(),
    owner = payer.publicKey,
    mint = fixtureWallet().publicKey;
  const source = getAssociatedTokenAddressSync(NATIVE_MINT, owner);
  const destination = getAssociatedTokenAddressSync(mint, owner);
  const spend = 2_000_000n,
    received = 800_001n,
    rent = 2_039_280;
  const pool = fixtureWallet().publicKey;
  const swap = new TransactionInstruction({
    programId: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'),
    keys: [pool, source, destination].map((pubkey) => ({
      pubkey,
      isWritable: true,
      isSigner: false,
    })),
    data: Buffer.from([7]),
  });
  const t = transactionFixture(
    [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      createAssociatedTokenAccountIdempotentInstruction(owner, source, owner, NATIVE_MINT),
      createAssociatedTokenAccountIdempotentInstruction(owner, destination, owner, mint),
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: source, lamports: spend }),
      createSyncNativeInstruction(source),
      swap,
      createCloseAccountInstruction(source, owner, owner),
      memoIx(),
    ],
    payer
  );
  const job = jobFor(t, 'holder_conversion', {
    lamports: spend.toString(),
    details: { assetMint: mint.toBase58(), market: pool.toBase58() },
  });
  Object.assign(job.expectations, {
    pool: pool.toBase58(),
    payoutMint: mint.toBase58(),
    quoteAta: source.toBase58(),
    tokenAta: destination.toBase58(),
    maximumSpendLamports: spend.toString(),
    minimumPayoutUnits: '800000',
    instruction: {
      program: swap.programId.toBase58(),
      accounts: swap.keys.map((k) => k.pubkey.toBase58()),
      dataBase64: swap.data.toString('base64'),
    },
  });
  t.balance(owner.toBase58(), 100_000_000, 100_000_000 - Number(spend) - rent - 5000);
  t.balance(source.toBase58(), 0, 0);
  const index = t.balance(destination.toBase58(), 0, rent);
  t.response.meta!.postTokenBalances = [
    {
      accountIndex: index,
      mint: mint.toBase58(),
      owner: owner.toBase58(),
      uiTokenAmount: { amount: received.toString(), decimals: 12, uiAmount: null },
    },
  ];
  const evidence = await t.evidence();
  expect(await verifyWalletEffect(t.rpc, job, evidence)).toMatchObject({
    receivedPayoutUnits: received,
    collectorDebitLamports: spend,
    operatingCostLamports: BigInt(rent + 5000),
  });
  job.expectations.minimumPayoutUnits = (received + 1n).toString();
  await expect(verifyWalletEffect(t.rpc, job, evidence)).rejects.toThrow(
    'finalized SOL and token balances'
  );
});
it('reconciles the exact atomic hSOL bridge and rejects a partial WSOL handoff', async () => {
  const payer = fixtureWallet(),
    owner = payer.publicKey;
  const hsol = new PublicKey(HSOL_REWARD_MINT),
    wxmr = fixtureWallet().publicKey;
  const source = getAssociatedTokenAddressSync(hsol, owner);
  const wrapped = getAssociatedTokenAddressSync(NATIVE_MINT, owner);
  const destination = getAssociatedTokenAddressSync(wxmr, owner);
  const [bridgeHsol, bridgeWsol, payoutWsol, market] = Array.from(
    { length: 4 },
    () => fixtureWallet().publicKey
  ) as [PublicKey, PublicKey, PublicKey, PublicKey];
  const programId = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
  const ammInstruction = (keys: PublicKey[], tag: number) =>
    new TransactionInstruction({
      programId,
      keys: keys.map((pubkey) => ({ pubkey, isWritable: true, isSigner: false })),
      data: Buffer.from([tag]),
    });
  const bridge = ammInstruction(
    [HSOL_BRIDGE_POOL, source, wrapped, bridgeHsol, bridgeWsol, TOKEN_PROGRAM_ID],
    1
  );
  const payout = ammInstruction([market, wrapped, destination, payoutWsol, TOKEN_PROGRAM_ID], 2);
  const transaction = transactionFixture(
    [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 550000 }),
      createAssociatedTokenAccountIdempotentInstruction(owner, wrapped, owner, NATIVE_MINT),
      createAssociatedTokenAccountIdempotentInstruction(owner, destination, owner, wxmr),
      bridge,
      payout,
      createCloseAccountInstruction(wrapped, owner, owner),
      memoIx(),
    ],
    payer
  );
  const serialize = (instruction: TransactionInstruction) => ({
    program: instruction.programId.toBase58(),
    accounts: instruction.keys.map(({ pubkey }) => pubkey.toBase58()),
    dataBase64: instruction.data.toString('base64'),
  });
  const job = jobFor(transaction, 'holder_conversion', {
    lamports: '10000',
    details: {
      sourceMint: HSOL_REWARD_MINT,
      assetMint: wxmr.toBase58(),
      market: market.toBase58(),
    },
  });
  Object.assign(job.expectations, {
    pool: market.toBase58(),
    quoteMint: HSOL_REWARD_MINT,
    tokenAta: destination.toBase58(),
    quoteAta: wrapped.toBase58(),
    payoutMint: wxmr.toBase58(),
    maximumSpendLamports: '10000',
    minimumPayoutUnits: '150',
    bridgeAmount: '12000',
    bridgePool: HSOL_BRIDGE_POOL.toBase58(),
    bridgeHsolVault: bridgeHsol.toBase58(),
    bridgeWsolVault: bridgeWsol.toBase58(),
    payoutWsolVault: payoutWsol.toBase58(),
    instruction: serialize(payout),
    bridgeInstruction: serialize(bridge),
  });
  const index = (key: PublicKey) =>
    transaction.accounts.findIndex((account) => account.equals(key));
  const token = (key: PublicKey, mint: PublicKey, amount: string) => ({
    accountIndex: index(key),
    mint: mint.toBase58(),
    uiTokenAmount: { amount, decimals: 9, uiAmount: null as null },
  });
  const transfer = (from: PublicKey, to: PublicKey, amount: bigint) => {
    const data = Buffer.alloc(9);
    data[0] = 3;
    data.writeBigUInt64LE(amount, 1);
    return {
      programIdIndex: index(TOKEN_PROGRAM_ID),
      accounts: [index(from), index(to), index(owner)],
      data: bs58.encode(data),
    };
  };
  transaction.balance(owner.toBase58(), 10000000, 10000000 - 2039280 - 5000);
  transaction.balance(wrapped.toBase58(), 0, 0);
  transaction.balance(destination.toBase58(), 0, 2039280);
  const meta = transaction.response.meta!;
  meta.preTokenBalances = [
    token(source, hsol, '10000'),
    token(bridgeWsol, NATIVE_MINT, '20000'),
    token(payoutWsol, NATIVE_MINT, '10'),
  ];
  meta.postTokenBalances = [token(source, hsol, '50'), token(destination, wxmr, '151')];
  meta.innerInstructions = [
    {
      index: 3,
      instructions: [transfer(source, bridgeHsol, 9950n), transfer(bridgeWsol, wrapped, 12000n)],
    },
    { index: 4, instructions: [transfer(wrapped, payoutWsol, 12000n)] },
  ];
  expect(
    await verifyWalletEffect(transaction.rpc, job, await transaction.evidence())
  ).toMatchObject({
    collectorDebitLamports: 9950n,
    receivedPayoutUnits: 151n,
  });
  meta.innerInstructions[1]!.instructions[0] = transfer(wrapped, payoutWsol, 11999n);
  await expect(
    verifyWalletEffect(transaction.rpc, job, await transaction.evidence())
  ).rejects.toThrow('bridge balances');
});

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
  it('requires the exact hSOL credit and accounts for SOL rent separately', async () => {
    const payer = fixtureWallet();
    const recipient = fixtureWallet().publicKey;
    const mint = new PublicKey(HSOL_REWARD_MINT);
    const source = getAssociatedTokenAddressSync(mint, payer.publicKey);
    const destination = getAssociatedTokenAddressSync(mint, recipient);
    const amount = 800000n;
    const rent = 2039280;
    const t = transactionFixture(
      [
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          destination,
          recipient,
          mint
        ),
        createTransferCheckedInstruction(source, mint, destination, payer.publicKey, amount, 9),
        memoIx(),
      ],
      payer
    );
    t.balance(payer.publicKey.toBase58(), 10000000, 10000000 - rent - 5000);
    const destinationIndex = t.balance(destination.toBase58(), 0, rent);
    const sourceIndex = t.balance(source.toBase58(), rent, rent);
    const token = (accountIndex: number, units: bigint) => ({
      accountIndex,
      mint: HSOL_REWARD_MINT,
      uiTokenAmount: { amount: String(units), decimals: 9, uiAmount: null as null },
    });
    t.response.meta!.preTokenBalances = [token(sourceIndex, amount * 2n)];
    t.response.meta!.postTokenBalances = [
      token(sourceIndex, amount),
      token(destinationIndex, amount),
    ];
    const job = jobFor(t, 'creator_claim', {
      recipient: recipient.toBase58(),
      lamports: String(amount),
      details: { assetMint: HSOL_REWARD_MINT },
    });
    Object.assign(job.expectations, {
      recipient: job.recipient,
      expectedLamports: job.lamports,
      quoteMint: HSOL_REWARD_MINT,
    });
    expect(await verifyWalletEffect(t.rpc, job, await t.evidence())).toMatchObject({
      paidLamports: amount,
      operatingCostLamports: BigInt(rent + 5000),
    });
    t.response.meta!.postTokenBalances = [
      token(sourceIndex, amount),
      token(destinationIndex, amount - 1n),
    ];
    await expect(verifyWalletEffect(t.rpc, job, await t.evidence())).rejects.toThrow(
      'balance mismatch'
    );
  });
});
