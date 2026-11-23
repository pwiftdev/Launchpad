import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Pool, PoolClient } from 'pg';
import { BorshCoder, type Idl } from '@coral-xyz/anchor';
import BN from 'bn.js';
import bs58 from 'bs58';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveIdl,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  claimAddress,
  claimCreatorInstruction,
  claimCommunityInstruction,
  claimPlatformInstruction,
  collectFeesInstruction,
  epochAddress,
  vaultAddresses,
  u64,
} from '@/lib/vault/client';
import discriminators from '@/lib/vault/discriminators.json';
import { FinancialStore, encodeFundingPlan, type PreparedExecution } from './financialStore';
import { decodeFinalizedDbcFees, type FeeSource } from './feeIngestion';
import { FinalizedVerifier } from './chainEvidence';
import { verifyFundingReceipt } from './fundingReceipt';
import { verifyUnsignedClaimExpiry, verifyUnsignedBuybackExpiry } from './claimRecovery';
import { verifyExpiredCommunityClaim } from './claimRenewal';
import { collectHolderSnapshot } from './holderSnapshot';
import { snapshotFixture } from './holderSnapshotFixture';
import {
  fixtureGenesis,
  fixtureWallet,
  transactionFixture,
  unsignedTransaction,
} from './financialFixtures';

const program = fixtureWallet().publicKey,
  config = fixtureWallet().publicKey,
  poolKey = fixtureWallet().publicKey;
let db: PGlite, store: FinancialStore;
let seedMint: PublicKey, creator: ReturnType<typeof fixtureWallet>;
const coder = new BorshCoder(DynamicBondingCurveIdl as Idl);
const migration = (name: string) =>
  readFileSync(new URL(`../../../../../scripts/migrations/${name}`, import.meta.url), 'utf8');

beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  let queue = Promise.resolve();
  const adapter = {
    connect: async () => {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      return {
        query: async (sql: string, parameters?: unknown[]) => {
          const result = await db.query(sql, parameters);
          return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
        },
        release,
      } as unknown as PoolClient;
    },
  } as Pick<Pool, 'connect'>;
  store = new FinancialStore(adapter, program.toBase58(), async () => true);
}, 20_000);
beforeEach(async () => {
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.exec(migration('003-launch-registry.sql'));
  await db.exec(migration('004-financial.sql'));
  await db.exec(migration('008-financial-realization.sql'));
  await db.exec(migration('011-zero-owned-fees.sql'));
  await db.exec(migration('010-community-claim-renewal.sql'));
  seedMint = fixtureWallet().publicKey;
  creator = fixtureWallet();
});
afterAll(async () => {
  await db?.close();
});

async function seed(mode: 'creator' | 'community' = 'creator', mint = seedMint) {
  seedMint = mint;
  await db.query(
    `INSERT INTO launch_configs(network_genesis,config_key,policy_version,expected_fee_claimer,
    expected_leftover_receiver,config_digest,verified_slot) VALUES($1,$2,'rinse-v1',$3,$3,$4,1)`,
    [fixtureGenesis, config.toBase58(), creator.publicKey.toBase58(), 'a'.repeat(64)]
  );
  await db.query(
    `INSERT INTO launch_coins(network_genesis,mint,dbc_pool,config_key,original_deployer,mode,
    recipient,policy_version,activation_point,creation_signature,finalized_slot)
    VALUES($1,$2,$3,$4,$5,$6,$5,'rinse-v1',1000,$7,1)`,
    [
      fixtureGenesis,
      mint.toBase58(),
      poolKey.toBase58(),
      config.toBase58(),
      creator.publicKey.toBase58(),
      mode,
      'creation-' + mint.toBase58(),
    ]
  );
}

async function fees(
  mode: 'creator' | 'community',
  tradeTime = 1100,
  eventCount = 1,
  compatibility = false
) {
  const source: FeeSource = {
    networkGenesis: fixtureGenesis,
    mint: seedMint.toBase58(),
    pool: poolKey.toBase58(),
    configKey: config.toBase58(),
    activationPoint: 1000,
    mode,
  };
  const authority = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    DYNAMIC_BONDING_CURVE_PROGRAM_ID
  )[0];
  const swapTag = DynamicBondingCurveIdl.instructions.find(
    (instruction) => instruction.name === 'swap'
  )!.discriminator;
  const test = transactionFixture(
    Array.from(
      { length: eventCount },
      () =>
        new TransactionInstruction({
          programId: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
          keys: [
            { pubkey: authority, isSigner: false, isWritable: false },
            { pubkey: poolKey, isSigner: false, isWritable: true },
          ],
          data: Buffer.concat([Buffer.from(swapTag), Buffer.alloc(16)]),
        })
    )
  );
  const event = coder.types.encode('EvtSwap2', {
    pool: poolKey,
    config,
    trade_direction: 1,
    has_referral: false,
    swap_parameters: { amount_0: new BN(1000), amount_1: new BN(0), swap_mode: 0 },
    swap_result: {
      included_fee_input_amount: new BN(1000),
      excluded_fee_input_amount: new BN(875),
      amount_left: new BN(0),
      output_amount: new BN(10),
      next_sqrt_price: new BN(1),
      trading_fee: new BN(100),
      protocol_fee: new BN(25),
      referral_fee: new BN(0),
    },
    quote_reserve_amount: new BN(1),
    migration_threshold: new BN(1),
    current_timestamp: new BN(tradeTime),
  });
  const eventDiscriminator = DynamicBondingCurveIdl.events.find(
    (item) => item.name === 'EvtSwap2'
  )!.discriminator;
  const index = test.accounts.findIndex((key) => key.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID));
  const authorityIndex = test.accounts.findIndex((key) => key.equals(authority));
  const modern = {
    programIdIndex: index,
    accounts: [authorityIndex],
    data: bs58.encode(
      Buffer.concat([
        Buffer.from('e445a52e51cb9a1d', 'hex'),
        Buffer.from(eventDiscriminator),
        event,
      ])
    ),
  };
  const legacyData = coder.types.encode('EvtSwap', {
    pool: poolKey,
    config,
    trade_direction: 1,
    has_referral: false,
    params: { amount_in: new BN(1000), minimum_amount_out: new BN(0) },
    swap_result: {
      actual_input_amount: new BN(1000),
      output_amount: new BN(10),
      next_sqrt_price: new BN(1),
      trading_fee: new BN(100),
      protocol_fee: new BN(25),
      referral_fee: new BN(0),
    },
    amount_in: new BN(1000),
    current_timestamp: new BN(tradeTime),
  });
  const legacy = {
    programIdIndex: index,
    accounts: [authorityIndex],
    data: bs58.encode(
      Buffer.concat([
        Buffer.from('e445a52e51cb9a1d', 'hex'),
        Buffer.from(
          DynamicBondingCurveIdl.events.find((item) => item.name === 'EvtSwap')!.discriminator
        ),
        legacyData,
      ])
    ),
  };
  test.response.meta!.innerInstructions = Array.from({ length: eventCount }, (_unused, outer) => ({
    index: outer,
    instructions: compatibility ? [legacy, modern] : [modern],
  }));
  const result = decodeFinalizedDbcFees(await test.evidence(), source);
  expect(result).toHaveLength(eventCount);
  return result;
}

async function fund(mode: 'creator' | 'community', tradeTime = 1100) {
  const events = await fees(mode, tradeTime);
  await store.ingestFinalizedFees(events);
  const plan = await store.fundingPlan(fixtureGenesis, seedMint.toBase58(), events);
  const operator = fixtureWallet(),
    addresses = vaultAddresses(program, seedMint),
    sourceVault = fixtureWallet().publicKey;
  const claimAccounts = Array.from({ length: 14 }, () => ({
    pubkey: fixtureWallet().publicKey,
    isSigner: false,
    isWritable: true,
  }));
  claimAccounts[2]!.pubkey = poolKey;
  claimAccounts[4]!.pubkey = addresses.quoteAccount;
  claimAccounts[6]!.pubkey = sourceVault;
  const ix = collectFeesInstruction({
    programId: program,
    mint: seedMint,
    operator: operator.publicKey,
    dexProgram: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
    claimAccounts,
    fundingId: plan.fundingId,
    commitment: plan.commitment,
    events: plan.phases,
  });
  expect(ix.data).toEqual(encodeFundingPlan(plan));
  const test = transactionFixture([ix], operator);
  test.balance(addresses.coin.toBase58(), 10_000_000, 10_000_000 + Number(plan.lamports) + 2039280);
  const nativeIndex = test.balance(addresses.quoteAccount.toBase58(), 2039280, 0);
  test.response.meta!.preTokenBalances = [
    {
      accountIndex: nativeIndex,
      mint: NATIVE_MINT.toBase58(),
      owner: addresses.coin.toBase58(),
      uiTokenAmount: { amount: '0', decimals: 9, uiAmount: 0, uiAmountString: '0' },
    },
  ];
  const sourceIndex = test.accounts.findIndex((key) => key.equals(sourceVault));
  test.response.meta!.preTokenBalances.push({
    accountIndex: sourceIndex,
    mint: NATIVE_MINT.toBase58(),
    owner: poolKey.toBase58(),
    uiTokenAmount: { amount: '1000', decimals: 9, uiAmount: 0.000001, uiAmountString: '0.000001' },
  });
  const transfer = Buffer.alloc(9);
  transfer[0] = 3;
  transfer.writeBigUInt64LE(plan.lamports, 1);
  test.response.meta!.innerInstructions = [
    {
      index: 0,
      instructions: [
        {
          programIdIndex: test.accounts.findIndex((key) => key.equals(TOKEN_PROGRAM_ID)),
          accounts: [sourceIndex, nativeIndex, sourceIndex],
          data: bs58.encode(transfer),
        },
      ],
    },
  ];
  const receiptData = Buffer.alloc(138);
  receiptData.write('RFUND001');
  receiptData[8] = 1;
  addresses.coin.toBuffer().copy(receiptData, 10);
  Buffer.from(plan.fundingId, 'hex').copy(receiptData, 42);
  Buffer.from(plan.commitment, 'hex').copy(receiptData, 74);
  receiptData.writeBigUInt64LE(plan.lamports, 106);
  receiptData.writeBigUInt64LE(1000n, 114);
  test.rpc.getAccountInfoAndContext = async () => ({
    context: { slot: 1000 },
    value: {
      owner: program,
      data: receiptData,
      lamports: 2039280,
      executable: false,
      rentEpoch: 0,
    },
  });
  const evidence = await test.evidence();
  const receipt = await verifyFundingReceipt(test.rpc, evidence, {
    program: program.toBase58(),
    mint: seedMint.toBase58(),
    fundingId: plan.fundingId,
    commitment: plan.commitment,
    total: plan.lamports,
  });
  const input = {
    evidence,
    receipt,
    mint: seedMint.toBase58(),
    vault: addresses.coin.toBase58(),
    events,
    sourceQuoteVault: sourceVault.toBase58(),
    unwrapAccount: addresses.quoteAccount.toBase58(),
    instruction: {
      accounts: ix.keys.map((key) => key.pubkey.toBase58()),
      data: ix.data,
      instructionIndex: 0,
    },
  };
  const result = await store.recordVerifiedFunding(input);
  return { plan, input, result, events };
}

async function creatorPlan(
  amount = 50n
): Promise<{ input: PreparedExecution; test: ReturnType<typeof transactionFixture> }> {
  const instruction = claimCreatorInstruction(program, seedMint, creator.publicKey, amount);
  const test = transactionFixture([instruction], creator);
  return {
    input: {
      networkGenesis: fixtureGenesis,
      mint: seedMint.toBase58(),
      kind: 'creator_claim',
      intentKey: 'claim-creator',
      lamports: amount,
      recipient: creator.publicKey.toBase58(),
      transactionBase64: unsignedTransaction(test.tx),
      lastValidBlockHeight: 2000,
      clock: await new FinalizedVerifier(test.rpc, fixtureGenesis).clock(),
      expectation: {
        program: program.toBase58(),
        accounts: instruction.keys.map((key) => key.pubkey.toBase58()),
        dataBase64: instruction.data.toString('base64'),
        vault: vaultAddresses(program, seedMint).coin.toBase58(),
        effect: 'sol_claim',
      },
    },
    test,
  };
}

describe('durable funded financial ledger', () => {
  it('pins company withdrawal to the reviewed treasury and settles its actual funded payout once', async () => {
    await seed();
    await fund('creator');
    const addresses = vaultAddresses(program, seedMint),
      ix = claimPlatformInstruction(program, seedMint, creator.publicKey, 50n);
    const test = transactionFixture([ix], creator);
    const input: PreparedExecution = {
      networkGenesis: fixtureGenesis,
      mint: seedMint.toBase58(),
      kind: 'platform_claim',
      intentKey: 'treasury-one',
      lamports: 50n,
      recipient: creator.publicKey.toBase58(),
      transactionBase64: unsignedTransaction(test.tx),
      lastValidBlockHeight: 2000,
      clock: await new FinalizedVerifier(test.rpc, fixtureGenesis).clock(),
      expectation: {
        program: program.toBase58(),
        accounts: ix.keys.map((key) => key.pubkey.toBase58()),
        dataBase64: ix.data.toString('base64'),
        vault: addresses.coin.toBase58(),
        effect: 'sol_claim',
      },
    };
    await expect(
      store.prepareExecution({ ...input, recipient: fixtureWallet().publicKey.toBase58() })
    ).rejects.toThrow('treasury');
    await expect(
      store.prepareExecution({
        ...input,
        expectation: {
          ...input.expectation,
          dataBase64: claimCreatorInstruction(
            program,
            seedMint,
            creator.publicKey,
            50n
          ).data.toString('base64'),
        },
      })
    ).rejects.toThrow('reviewed vault instruction');
    const [first, retry] = await Promise.all([
      store.prepareExecution(input),
      store.prepareExecution({ ...input, intentKey: 'retry' }),
    ]);
    expect(first.id).toBe(retry.id);
    await store.attachSignedTransaction(first.id, test.tx.serialize().toString('base64'));
    test.balance(addresses.coin.toBase58(), 10_000_000, 9_999_950);
    test.balance(creator.publicKey.toBase58(), 10_000_000, 10_000_000 + 50 - 5000);
    expect((await store.settleExecution(first.id, await test.evidence())).status).toBe('finalized');
    expect((await store.settleExecution(first.id, await test.evidence())).status).toBe('finalized');
    expect(
      (await store.balances(fixtureGenesis, seedMint.toBase58())).find(
        (row) => row.bucket === 'platform'
      )
    ).toMatchObject({ funded: '50', reserved: '0', spent: '50' });
  });
  it('indexes every event in a multi-swap transaction and reserves overlapping funding sets atomically', async () => {
    await seed();
    const events = await fees('creator', 1100, 2);
    expect(`${events[0]!.instructionIndex}:${events[0]!.eventIndex}`).not.toBe(
      `${events[1]!.instructionIndex}:${events[1]!.eventIndex}`
    );
    expect(await store.ingestFinalizedFees(events)).toBe(2);
    const first = await store.fundingPlan(fixtureGenesis, seedMint.toBase58(), [events[0]!]);
    expect(first.phases).toEqual([{ phase: 1, net: 100n }]);
    await expect(store.fundingPlan(fixtureGenesis, seedMint.toBase58(), events)).rejects.toThrow();
    expect(
      (await db.query<{ count: string }>('SELECT count(*) FROM financial_funding_plans')).rows[0]!
        .count
    ).toBe(1);
  });
  it('credits compatibility EvtSwap+EvtSwap2 emissions once per real invocation while preserving identical multi-swaps', async () => {
    await seed();
    const events = await fees('creator', 1100, 2, true);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.eventIndex === 2)).toBe(true);
    expect(await store.ingestFinalizedFees(events)).toBe(2);
    const balance = (await store.balances(fixtureGenesis, seedMint.toBase58())).find(
      (row) => row.bucket === 'creator'
    );
    expect(balance?.accrued).toBe('100');
  });
  it('migrates twice, rejects forged evidence, deduplicates all finalized event identities and never funds estimates', async () => {
    await seed();
    await db.exec(migration('004-financial.sql'));
    const events = await fees('creator');
    expect(await store.ingestFinalizedFees(events)).toBe(1);
    expect(await store.ingestFinalizedFees(events)).toBe(0);
    await expect(store.ingestFinalizedFees([{ ...events[0]! }])).rejects.toThrow('finalized');
    const balance = await store.balances(fixtureGenesis, seedMint.toBase58());
    expect(balance.find((row) => row.bucket === 'creator')).toMatchObject({
      accrued: '50',
      funded: '0',
      available: '0',
    });
    await expect(store.prepareExecution((await creatorPlan()).input)).rejects.toThrow('funded');
    await expect(db.query('DELETE FROM financial_fee_events')).rejects.toThrow('append-only');
  });
  it('credits only a verified program-vault deposit, prevents refilling the same fees and conserves budgets', async () => {
    await seed();
    const funding = await fund('creator');
    expect(funding.result).toMatchObject({ inserted: true, lamports: 100n });
    expect(await store.recordVerifiedFunding(funding.input)).toMatchObject({ inserted: false });
    await expect(
      store.fundingPlan(fixtureGenesis, seedMint.toBase58(), funding.events)
    ).rejects.toThrow('already funded');
    const balances = await store.balances(fixtureGenesis, seedMint.toBase58());
    expect(balances.reduce((sum, row) => sum + BigInt(row.funded), 0n)).toBe(100n);
    expect(balances.find((row) => row.bucket === 'creator')?.available).toBe('50');
  });
  it('persists intent before submission and tolerates concurrent prepare and relay timeouts without a second spend', async () => {
    await seed();
    await fund('creator');
    const { input, test } = await creatorPlan();
    const prepared = await Promise.all([
      store.prepareClaim(input),
      store.prepareClaim({ ...input, intentKey: 'other-client-retry' }),
    ]);
    expect(prepared[0]!.id).toBe(prepared[1]!.id);
    expect(
      (await store.balances(fixtureGenesis, seedMint.toBase58())).find(
        (row) => row.bucket === 'creator'
      )?.reserved
    ).toBe('50');
    const signed = await store.attachSignedTransaction(
      prepared[0]!.id,
      test.tx.serialize().toString('base64')
    );
    expect(signed.status).toBe('signed');
    await store.markSubmitted(signed.id);
    await store.markUncertain(signed.id);
    expect((await store.job(signed.id))?.status).toBe('manual_review');
    const vault = vaultAddresses(program, seedMint).coin.toBase58();
    test.balance(vault, 10_000_000, 9_999_950);
    test.balance(creator.publicKey.toBase58(), 10_000_000, 10_000_000 + 50 - 5000);
    const evidence = await test.evidence();
    expect((await store.settleExecution(signed.id, evidence)).status).toBe('finalized');
    expect((await store.settleExecution(signed.id, evidence)).status).toBe('finalized');
    const balance = (await store.balances(fixtureGenesis, seedMint.toBase58())).find(
      (row) => row.bucket === 'creator'
    );
    expect(balance).toMatchObject({ funded: '50', reserved: '0', spent: '50', available: '0' });
  });
  it('rejects creator reassignment and receipt payouts to another wallet', async () => {
    await seed();
    await fund('creator');
    const { input, test } = await creatorPlan();
    await expect(
      store.prepareClaim({ ...input, recipient: fixtureWallet().publicKey.toBase58() })
    ).rejects.toThrow('original');
    const job = await store.prepareClaim(input);
    await store.attachSignedTransaction(job.id, test.tx.serialize().toString('base64'));
    test.balance(vaultAddresses(program, seedMint).coin.toBase58(), 10_000_000, 9_999_950);
    await expect(store.settleExecution(job.id, await test.evidence())).rejects.toThrow(
      'claim amount'
    );
    expect((await store.job(job.id))?.status).toBe('signed');
  });
  it('releases a failed finalized claim exactly once and refuses timeouts as failure evidence', async () => {
    await seed();
    await fund('creator');
    const { input, test } = await creatorPlan();
    const job = await store.prepareClaim(input);
    await store.attachSignedTransaction(job.id, test.tx.serialize().toString('base64'));
    await store.markSubmitted(job.id);
    await store.markUncertain(job.id);
    await expect(store.recordFinalizedFailure(job.id, {} as never)).rejects.toThrow('proof');
    test.response.meta!.err = { InstructionError: [0, 'InvalidArgument'] };
    const proof = await new FinalizedVerifier(test.rpc, fixtureGenesis).failure(
      test.signature,
      job.message_digest
    );
    expect((await store.recordFinalizedFailure(job.id, proof)).status).toBe('failed');
    expect((await store.recordFinalizedFailure(job.id, proof)).status).toBe('failed');
    expect(
      (await store.balances(fixtureGenesis, seedMint.toBase58())).find(
        (row) => row.bucket === 'creator'
      )
    ).toMatchObject({ reserved: '0', spent: '0', available: '50' });
  });
  it('renews only expired unsigned claims after checking actual unchanged custody and never unlocks a signed claim', async () => {
    await seed();
    await fund('creator');
    const { input, test } = await creatorPlan();
    const job = await store.prepareClaim(input),
      data = Buffer.alloc(347);
    data.write('RCOIN001');
    data[8] = 1;
    seedMint.toBuffer().copy(data, 11);
    creator.publicKey.toBuffer().copy(data, 107);
    data.writeBigUInt64LE(0n, 155);
    test.rpc.getBlockHeight = async () => 2001;
    test.rpc.isBlockhashValid = async () => ({ context: { slot: 1000 }, value: false });
    test.rpc.getAccountInfoAndContext = async () => ({
      context: { slot: 1000 },
      value: { owner: program, data, lamports: 2039280 + 50, executable: false, rentEpoch: 0 },
    });
    const mismatch = await verifyUnsignedClaimExpiry(test.rpc, job, program.toBase58());
    await expect(store.cancelUnsignedClaim(job.id, mismatch)).rejects.toThrow('reconcile');
    data.writeBigUInt64LE(50n, 155);
    const proof = await verifyUnsignedClaimExpiry(test.rpc, job, program.toBase58());
    expect((await store.cancelUnsignedClaim(job.id, proof)).status).toBe('failed');
    expect(
      (await store.balances(fixtureGenesis, seedMint.toBase58())).find(
        (row) => row.bucket === 'creator'
      )?.reserved
    ).toBe('0');
    const retry = await creatorPlan();
    retry.input.intentKey = 'fresh-wallet-intent';
    const next = await store.prepareClaim(retry.input);
    await store.attachSignedTransaction(next.id, retry.test.tx.serialize().toString('base64'));
    await expect(
      verifyUnsignedClaimExpiry(test.rpc, (await store.job(next.id))!, program.toBase58())
    ).rejects.toThrow('unsigned');
  });
  it('recovers expired unsigned buyback reservations only with the unchanged native nonce and full budget', async () => {
    await seed();
    await fund('creator', 1000);
    const addresses = vaultAddresses(program, seedMint),
      operator = fixtureWallet(),
      baseVault = fixtureWallet().publicKey;
    const bytes = Buffer.concat([
      Buffer.from(discriminators.execute_buyback_burn),
      u64(3n),
      u64(80n),
      u64(25n),
      u64(3660n),
      Buffer.from([0, 1, 0, 0]),
    ]);
    const keys = [
      operator.publicKey,
      addresses.settings,
      addresses.coin,
      addresses.quoteAccount,
      addresses.tokenAccount,
      seedMint,
      TOKEN_PROGRAM_ID,
      DYNAMIC_BONDING_CURVE_PROGRAM_ID,
      poolKey,
      baseVault,
    ];
    const test = transactionFixture(
      [
        new TransactionInstruction({
          programId: program,
          keys: keys.map((pubkey, i) => ({ pubkey, isSigner: i === 0, isWritable: true })),
          data: bytes,
        }),
      ],
      operator
    );
    const job = await store.prepareExecution({
      networkGenesis: fixtureGenesis,
      mint: seedMint.toBase58(),
      kind: 'buyback',
      intentKey: 'expired-buyback',
      lamports: 80n,
      transactionBase64: unsignedTransaction(test.tx),
      lastValidBlockHeight: 2000,
      clock: await new FinalizedVerifier(test.rpc, fixtureGenesis).clock(),
      expectation: {
        program: program.toBase58(),
        accounts: keys.map(String),
        dataBase64: bytes.toString('base64'),
        vault: addresses.coin.toBase58(),
        effect: 'buyback_burn',
        tokenAccount: addresses.tokenAccount.toBase58(),
        poolTokenVault: baseVault.toBase58(),
        minTokens: '25',
        unwrapAccount: addresses.quoteAccount.toBase58(),
      },
    });
    const data = Buffer.alloc(347);
    data.write('RCOIN001');
    data[8] = 1;
    seedMint.toBuffer().copy(data, 11);
    data.writeBigUInt64LE(3n, 179);
    test.rpc.getBlockHeight = async () => 2001;
    test.rpc.isBlockhashValid = async () => ({ context: { slot: 1000 }, value: false });
    test.rpc.getAccountInfoAndContext = async () => ({
      context: { slot: 1000 },
      value: { owner: program, data, lamports: 2039280 + 80, executable: false, rentEpoch: 0 },
    });
    await expect(store.cancelUnsignedBuyback(job.id, {} as never)).rejects.toThrow('independently');
    const mismatch = await verifyUnsignedBuybackExpiry(test.rpc, job, program.toBase58());
    await expect(store.cancelUnsignedBuyback(job.id, mismatch)).rejects.toThrow('reconcile');
    data.writeBigUInt64LE(80n, 147);
    data.writeBigUInt64LE(4n, 179);
    await expect(verifyUnsignedBuybackExpiry(test.rpc, job, program.toBase58())).rejects.toThrow(
      'nonce'
    );
    data.writeBigUInt64LE(3n, 179);
    const proof = await verifyUnsignedBuybackExpiry(test.rpc, job, program.toBase58());
    expect((await store.cancelUnsignedBuyback(job.id, proof)).status).toBe('failed');
    expect((await store.cancelUnsignedBuyback(job.id, proof)).status).toBe('failed');
    expect(
      (await store.balances(fixtureGenesis, seedMint.toBase58())).find(
        (row) => row.bucket === 'rinse_buyback'
      )
    ).toMatchObject({ available: '80', reserved: '0', spent: '0' });
    await expect(
      verifyUnsignedBuybackExpiry(
        test.rpc,
        { ...job, signature: test.signature, status: 'manual_review' },
        program.toBase58()
      )
    ).rejects.toThrow('unsigned');
  });
  it('settles only atomic purchases that burn the exact newly received tokens while retaining older balances', async () => {
    await seed();
    await fund('creator', 1000);
    const addresses = vaultAddresses(program, seedMint),
      operator = fixtureWallet(),
      baseVault = fixtureWallet().publicKey;
    const data = Buffer.concat([
      Buffer.from(discriminators.execute_buyback_burn),
      u64(0n),
      u64(80n),
      u64(25n),
      u64(3660n),
      Buffer.from([0, 1, 0, 0]),
    ]);
    const keys = [
      operator.publicKey,
      addresses.settings,
      addresses.coin,
      addresses.quoteAccount,
      addresses.tokenAccount,
      seedMint,
      TOKEN_PROGRAM_ID,
      DYNAMIC_BONDING_CURVE_PROGRAM_ID,
      poolKey,
      baseVault,
    ];
    const ix = new TransactionInstruction({
      programId: program,
      keys: keys.map((pubkey, index) => ({ pubkey, isSigner: index === 0, isWritable: true })),
      data,
    });
    const test = transactionFixture([ix], operator);
    const job = await store.prepareExecution({
      networkGenesis: fixtureGenesis,
      mint: seedMint.toBase58(),
      kind: 'buyback',
      intentKey: 'buyback0',
      lamports: 80n,
      transactionBase64: unsignedTransaction(test.tx),
      lastValidBlockHeight: 2000,
      clock: await new FinalizedVerifier(test.rpc, fixtureGenesis).clock(),
      expectation: {
        program: program.toBase58(),
        accounts: keys.map(String),
        dataBase64: data.toString('base64'),
        vault: addresses.coin.toBase58(),
        effect: 'buyback_burn',
        tokenAccount: addresses.tokenAccount.toBase58(),
        poolTokenVault: baseVault.toBase58(),
        minTokens: '25',
        unwrapAccount: addresses.quoteAccount.toBase58(),
      },
    });
    await store.attachSignedTransaction(job.id, test.tx.serialize().toString('base64'));
    test.balance(addresses.coin.toBase58(), 10_000_000, 10_000_000 - 80 + 2039280);
    const nativeIndex = test.balance(addresses.quoteAccount.toBase58(), 2039280, 0);
    const baseIndex = test.accounts.findIndex((key) => key.equals(baseVault)),
      tokenIndex = test.accounts.findIndex((key) => key.equals(addresses.tokenAccount));
    const token = (accountIndex: number, mint: string, amount: string, owner: string) => ({
      accountIndex,
      mint,
      owner,
      uiTokenAmount: { amount, decimals: 6, uiAmount: 0, uiAmountString: '0' },
    });
    test.response.meta!.preTokenBalances = [
      token(nativeIndex, NATIVE_MINT.toBase58(), '0', addresses.coin.toBase58()),
      token(baseIndex, seedMint.toBase58(), '100', poolKey.toBase58()),
      token(tokenIndex, seedMint.toBase58(), '5', addresses.coin.toBase58()),
    ];
    test.response.meta!.postTokenBalances = [
      token(baseIndex, seedMint.toBase58(), '75', poolKey.toBase58()),
      token(tokenIndex, seedMint.toBase58(), '5', addresses.coin.toBase58()),
    ];
    const transfer = Buffer.alloc(9);
    transfer[0] = 3;
    transfer.writeBigUInt64LE(25n, 1);
    const burn = Buffer.alloc(10);
    burn[0] = 15;
    burn.writeBigUInt64LE(30n, 1);
    burn[9] = 6;
    const tokenProgramIndex = test.accounts.findIndex((key) => key.equals(TOKEN_PROGRAM_ID));
    test.response.meta!.innerInstructions = [
      {
        index: 0,
        instructions: [
          {
            programIdIndex: tokenProgramIndex,
            accounts: [baseIndex, tokenIndex, baseIndex],
            data: bs58.encode(transfer),
          },
          {
            programIdIndex: tokenProgramIndex,
            accounts: [
              tokenIndex,
              test.accounts.findIndex((key) => key.equals(seedMint)),
              test.accounts.findIndex((key) => key.equals(addresses.coin)),
            ],
            data: bs58.encode(burn),
          },
        ],
      },
    ];
    await expect(store.settleExecution(job.id, await test.evidence())).rejects.toThrow('exactly');
    burn.writeBigUInt64LE(25n, 1);
    test.response.meta!.innerInstructions![0]!.instructions[1]!.data = bs58.encode(burn);
    expect((await store.settleExecution(job.id, await test.evidence())).received_tokens).toBe('25');
    expect(
      (await store.balances(fixtureGenesis, seedMint.toBase58())).find(
        (row) => row.bucket === 'rinse_buyback'
      )
    ).toMatchObject({ reserved: '0', spent: '80' });
  });
  it('keeps draft epochs unavailable until funded on-chain and preserves immutable owner proofs', async () => {
    const holders = snapshotFixture();
    await seed('community', holders.mint);
    await fund('community');
    const snapshot = await collectHolderSnapshot(holders.rpc, {
      networkGenesis: fixtureGenesis,
      mint: holders.mint.toBase58(),
      excludedOwners: new Set(),
    });
    await expect(
      store.createRewardEpoch({
        networkGenesis: fixtureGenesis,
        mint: seedMint.toBase58(),
        epoch: 2,
        snapshot,
      })
    ).rejects.toThrow('hourly');
    holders.rpc.getBlockTime = async () => 7260;
    const lateSnapshot = await collectHolderSnapshot(holders.rpc, {
      networkGenesis: fixtureGenesis,
      mint: holders.mint.toBase58(),
      excludedOwners: new Set(),
    });
    await expect(
      store.createRewardEpoch({
        networkGenesis: fixtureGenesis,
        mint: seedMint.toBase58(),
        epoch: 1,
        snapshot: lateSnapshot,
      })
    ).rejects.toThrow('hourly');
    const draft = await store.createRewardEpoch({
      networkGenesis: fixtureGenesis,
      mint: seedMint.toBase58(),
      epoch: 1,
      snapshot,
    });
    expect(draft).toMatchObject({ inserted: true, allocated: 49n, carry: 1n });
    const owner = holders.owners[0]!.publicKey.toBase58();
    expect(await store.claimable(fixtureGenesis, seedMint.toBase58(), owner)).toEqual([]);
    const epoch = await store.rewardEpoch(fixtureGenesis, seedMint.toBase58(), 1);
    expect(epoch?.allocations.reduce((sum, row) => sum + row.lamports, 0n)).toBe(49n);
    const addresses = vaultAddresses(program, seedMint),
      epochKey = epochAddress(program, addresses.coin, 1n),
      operator = fixtureWallet();
    const data = Buffer.concat([
      Buffer.from(discriminators.create_epoch),
      u64(1n),
      Buffer.from(epoch!.merkle_root, 'hex'),
      u64(BigInt(epoch!.snapshot_slot)),
      Buffer.from(epoch!.snapshot_digest, 'hex'),
      u64(49n),
    ]);
    const ix = new TransactionInstruction({
      programId: program,
      keys: [
        { pubkey: operator.publicKey, isSigner: true, isWritable: true },
        { pubkey: addresses.settings, isSigner: false, isWritable: false },
        { pubkey: addresses.coin, isSigner: false, isWritable: true },
        { pubkey: epochKey, isSigner: false, isWritable: true },
        { pubkey: PublicKey.default, isSigner: false, isWritable: false },
      ],
      data,
    });
    const test = transactionFixture([ix], operator);
    test.balance(addresses.coin.toBase58(), 10_000_000, 9_999_951);
    test.balance(epochKey.toBase58(), 0, 49 + 2039280);
    const epochData = Buffer.alloc(138);
    epochData.write('REPOCH01');
    epochData[8] = 1;
    addresses.coin.toBuffer().copy(epochData, 10);
    epochData.writeBigUInt64LE(1n, 42);
    Buffer.from(epoch!.merkle_root, 'hex').copy(epochData, 50);
    epochData.writeBigUInt64LE(BigInt(epoch!.snapshot_slot), 82);
    Buffer.from(epoch!.snapshot_digest, 'hex').copy(epochData, 90);
    epochData.writeBigUInt64LE(49n, 122);
    epochData.writeBigUInt64LE(49n, 130);
    test.rpc.getAccountInfoAndContext = async () => ({
      context: { slot: 1000 },
      value: {
        owner: program,
        data: epochData,
        lamports: 2039280 + 49,
        executable: false,
        rentEpoch: 0,
      },
    });
    await store.recordVerifiedEpochFunding({
      networkGenesis: fixtureGenesis,
      mint: seedMint.toBase58(),
      epoch: 1,
      evidence: await test.evidence(),
      instruction: { accounts: ix.keys.map((key) => key.pubkey.toBase58()), data },
    });
    const available = await store.claimable(fixtureGenesis, seedMint.toBase58(), owner);
    expect(available[0]).toMatchObject({ status: 'available', lamports: '37' });
    const claim = claimCommunityInstruction({
      programId: program,
      mint: seedMint,
      wallet: holders.owners[0]!.publicKey,
      epoch: 1n,
      amount: 37n,
      proof: available[0]!.proof,
    });
    let prepared = transactionFixture([claim], holders.owners[0]);
    const job = await store.prepareClaim({
      networkGenesis: fixtureGenesis,
      mint: seedMint.toBase58(),
      kind: 'community_claim',
      intentKey: 'epoch1-owner1',
      lamports: 37n,
      recipient: owner,
      epoch: 1,
      lastValidBlockHeight: 2000,
      transactionBase64: unsignedTransaction(prepared.tx),
      clock: await new FinalizedVerifier(prepared.rpc, fixtureGenesis).clock(),
      expectation: {
        program: program.toBase58(),
        accounts: claim.keys.map((key) => key.pubkey.toBase58()),
        dataBase64: claim.data.toString('base64'),
        vault: epochKey.toBase58(),
        effect: 'sol_claim',
      },
    });
    expect(job.status).toBe('prepared');
    expect((await store.claimable(fixtureGenesis, seedMint.toBase58(), owner))[0]?.status).toBe(
      'pending'
    );
    await store.attachSignedTransaction(job.id, prepared.tx.serialize().toString('base64'));
    const oldSigned = (await store.job(job.id))!,
      oldSignature = oldSigned.signature;
    const fresh = transactionFixture([claim], holders.owners[0]),
      coinData = Buffer.alloc(347);
    coinData.write('RCOIN001');
    coinData[8] = 1;
    coinData[10] = 1;
    seedMint.toBuffer().copy(coinData, 11);
    prepared.rpc.getBlockHeight = async () => 2001;
    prepared.rpc.isBlockhashValid = async () => ({ context: { slot: 1000 }, value: true });
    prepared.rpc.getLatestBlockhash = async () => ({
      blockhash: fresh.tx.recentBlockhash!,
      lastValidBlockHeight: 3000,
    });
    const account = (data: Buffer) => ({
      owner: program,
      data,
      lamports: 2039280 + 49,
      executable: false,
      rentEpoch: 0,
    });
    prepared.rpc.getMultipleAccountsInfoAndContext = async () => ({
      context: { slot: 1000 },
      value: [account(coinData), account(epochData), null],
    });
    await expect(
      verifyExpiredCommunityClaim(prepared.rpc, oldSigned, program.toBase58())
    ).rejects.toThrow('expired');
    prepared.rpc.isBlockhashValid = async () => ({ context: { slot: 1000 }, value: false });
    prepared.rpc.getMultipleAccountsInfoAndContext = async () => ({
      context: { slot: 1000 },
      value: [account(coinData), account(epochData), account(Buffer.alloc(82))],
    });
    await expect(
      verifyExpiredCommunityClaim(prepared.rpc, oldSigned, program.toBase58())
    ).rejects.toThrow('marker exists');
    prepared.rpc.getMultipleAccountsInfoAndContext = async () => ({
      context: { slot: 1000 },
      value: [account(coinData), account(epochData), null],
    });
    const renewal = await verifyExpiredCommunityClaim(prepared.rpc, oldSigned, program.toBase58());
    await expect(store.renewExpiredCommunityClaim(job.id, { ...renewal })).rejects.toThrow(
      'positive'
    );
    const renewals = await Promise.allSettled([
      store.renewExpiredCommunityClaim(job.id, renewal),
      store.renewExpiredCommunityClaim(job.id, renewal),
    ]);
    expect(renewals.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(renewals.filter((row) => row.status === 'rejected')).toHaveLength(1);
    expect((await store.job(job.id))?.signature).toBeNull();
    expect(
      (await db.query<{ signature: string }>('SELECT signature FROM financial_claim_attempts'))
        .rows[0]!.signature
    ).toBe(oldSignature);
    expect(
      (await store.balances(fixtureGenesis, seedMint.toBase58())).find(
        (row) => row.bucket === 'community'
      )
    ).toMatchObject({ funded: '50', reserved: '49', spent: '0' });
    prepared = fresh;
    await store.attachSignedTransaction(job.id, prepared.tx.serialize().toString('base64'));
    const marker = claimAddress(program, epochKey, holders.owners[0]!.publicKey);
    prepared.balance(epochKey.toBase58(), 2039280 + 49, 2039280 + 12);
    prepared.balance(owner, 10_000_000, 10_000_000 + 37 - 5000 - 2039280);
    const markerIndex = prepared.balance(marker.toBase58(), 0, 2039280),
      walletIndex = prepared.accounts.findIndex((key) => key.toBase58() === owner);
    const create = Buffer.alloc(52);
    create.writeBigUInt64LE(2039280n, 4);
    create.writeBigUInt64LE(82n, 12);
    program.toBuffer().copy(create, 20);
    prepared.response.meta!.innerInstructions = [
      {
        index: 0,
        instructions: [
          {
            programIdIndex: prepared.accounts.findIndex((key) => key.equals(PublicKey.default)),
            accounts: [walletIndex, markerIndex],
            data: bs58.encode(create),
          },
        ],
      },
    ];
    const markerData = Buffer.alloc(82);
    markerData.write('RCLAIM01');
    markerData[8] = 1;
    epochKey.toBuffer().copy(markerData, 10);
    holders.owners[0]!.publicKey.toBuffer().copy(markerData, 42);
    markerData.writeBigUInt64LE(37n, 74);
    prepared.rpc.getAccountInfoAndContext = async () => ({
      context: { slot: 1000 },
      value: {
        owner: program,
        data: markerData,
        lamports: 2039280,
        executable: false,
        rentEpoch: 0,
      },
    });
    expect((await store.settleExecution(job.id, await prepared.evidence())).status).toBe(
      'finalized'
    );
    expect((await store.claimable(fixtureGenesis, seedMint.toBase58(), owner))[0]?.status).toBe(
      'paid'
    );
    expect(
      (await store.balances(fixtureGenesis, seedMint.toBase58())).find(
        (row) => row.bucket === 'community'
      )
    ).toMatchObject({ funded: '50', reserved: '12', spent: '37', available: '1' });
    await expect(db.query('UPDATE financial_entitlements SET lamports=100')).rejects.toThrow(
      'append-only'
    );
  });
});
