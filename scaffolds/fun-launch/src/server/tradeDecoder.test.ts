import { describe, expect, it, vi } from 'vitest';
import { BorshCoder, type Idl } from '@coral-xyz/anchor';
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import { CP_AMM_PROGRAM_ID, CpAmmIdl } from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import bs58 from 'bs58';
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveIdl,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import dualFixture from './fixtures/dbc-dual-swap.json';
const rpc = vi.hoisted(() => ({ getSignaturesForAddress: vi.fn(), getTransactions: vi.fn() }));
vi.mock('./dbc', () => ({ connection: rpc }));
import { decodeTrade, decodeTrades } from './tradeDecoder';

const coder = new BorshCoder(CpAmmIdl as unknown as Idl),
  pool = Keypair.generate().publicKey;
function swapInstruction(
  programId: PublicKey,
  ownPool: PublicKey,
  authority = Keypair.generate().publicKey
) {
  const idl = programId.equals(CP_AMM_PROGRAM_ID) ? CpAmmIdl : DynamicBondingCurveIdl;
  const layout = idl.instructions.find((ix) => ix.name === 'swap2')!;
  const eventAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    programId
  )[0];
  const keys = layout.accounts.map((account) => ({
    pubkey:
      account.name === 'pool'
        ? ownPool
        : account.name === 'payer'
          ? authority
          : account.name === 'event_authority'
            ? eventAuthority
            : account.name === 'program'
              ? programId
              : Keypair.generate().publicKey,
    isSigner: account.name === 'payer',
    isWritable: account.name !== 'program' && account.name !== 'event_authority',
  }));
  return new TransactionInstruction({ programId, keys, data: Buffer.from(layout.discriminator) });
}
function response(
  instructions: TransactionInstruction[],
  events: Buffer[][],
  signature = 'swap',
  sponsor = Keypair.generate().publicKey
) {
  const message = new Transaction({
    feePayer: sponsor,
    recentBlockhash: PublicKey.default.toBase58(),
  })
    .add(...instructions)
    .compileMessage();
  return {
    slot: 100,
    blockTime: 1000,
    transaction: { signatures: [signature], message },
    meta: {
      err: null,
      loadedAddresses: { writable: [], readonly: [] },
      innerInstructions: instructions.map((instruction, index) => ({
        index,
        instructions: events[index]!.map((data) => ({
          programIdIndex: message.accountKeys.findIndex((key) => key.equals(instruction.programId)),
          accounts: [
            message.accountKeys.findIndex((key) =>
              key.equals(
                PublicKey.findProgramAddressSync(
                  [Buffer.from('__event_authority')],
                  instruction.programId
                )[0]
              )
            ),
          ],
          data: bs58.encode(data),
          stackHeight: 2,
        })),
      })),
    },
  } as unknown as VersionedTransactionResponse;
}
function fixture(baseIsA = true, collect = 1) {
  const amount = (value: number) => new BN(value);
  const payload = coder.types.encode('EvtSwap2', {
    pool,
    trade_direction: baseIsA ? 1 : 0,
    collect_fee_mode: collect,
    has_referral: false,
    params: { amount_0: amount(1_000_000_000), amount_1: amount(1), swap_mode: 0 },
    swap_result: {
      included_fee_input_amount: amount(1_000_000_000),
      excluded_fee_input_amount: amount(987_500_000),
      amount_left: amount(0),
      output_amount: amount(987_500_000),
      next_sqrt_price: new BN(1).shln(64),
      claiming_fee: amount(10_000_000),
      protocol_fee: amount(2_500_000),
      compounding_fee: amount(0),
      referral_fee: amount(0),
    },
    included_transfer_fee_amount_in: amount(1_000_000_000),
    included_transfer_fee_amount_out: amount(987_500_000),
    excluded_transfer_fee_amount_out: amount(987_500_000),
    current_timestamp: amount(1000),
    reserve_a_amount: amount(0),
    reserve_b_amount: amount(0),
  });
  const disc = CpAmmIdl.events.find((event) => event.name === 'EvtSwap2')!.discriminator;
  const data = Buffer.concat([Buffer.from('e445a52e51cb9a1d', 'hex'), Buffer.from(disc), payload]);
  return response([swapInstruction(CP_AMM_PROGRAM_ID, pool)], [[data]]);
}

describe('graduated trade display', () => {
  it('attributes sponsored trades to the input owner or actual swap authority, never the fee payer', () => {
    const authority = Keypair.generate().publicKey,
      sponsor = Keypair.generate().publicKey,
      owner = Keypair.generate().publicKey;
    const source = fixture();
    const event = source.meta!.innerInstructions![0]!.instructions[0]!.data;
    const instruction = swapInstruction(CP_AMM_PROGRAM_ID, pool, authority);
    const tx = response([instruction], [[Buffer.from(bs58.decode(event))]], 'sponsored', sponsor);
    expect(decodeTrade(tx, pool.toBase58(), { migratedBaseIsA: true })).toMatchObject({
      wallet: authority.toBase58(),
      walletRole: 'swap-authority',
    });
    const input =
      instruction.keys[
        CpAmmIdl.instructions
          .find((ix) => ix.name === 'swap2')!
          .accounts.findIndex((a) => a.name === 'input_token_account')
      ]!.pubkey;
    const index = tx.transaction.message
      .getAccountKeys()
      .keySegments()
      .flat()
      .findIndex((key) => key.equals(input));
    tx.meta!.preTokenBalances = [
      {
        accountIndex: index,
        mint: Keypair.generate().publicKey.toBase58(),
        owner: owner.toBase58(),
        uiTokenAmount: { amount: '1000000000', decimals: 9, uiAmount: 1, uiAmountString: '1' },
      },
    ];
    expect(decodeTrade(tx, pool.toBase58(), { migratedBaseIsA: true })).toMatchObject({
      wallet: owner.toBase58(),
      walletRole: 'token-owner',
    });
    expect(decodeTrade(tx, pool.toBase58(), { migratedBaseIsA: true })?.wallet).not.toBe(
      sponsor.toBase58()
    );
  });
  it('keeps distinct identical swaps in one router transaction', () => {
    const ownPool = new PublicKey(dualFixture.pool),
      one = swapInstruction(DYNAMIC_BONDING_CURVE_PROGRAM_ID, ownPool),
      two = swapInstruction(DYNAMIC_BONDING_CURVE_PROGRAM_ID, ownPool);
    const router = new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: [
        ...one.keys,
        ...two.keys,
        { pubkey: one.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.alloc(0),
    });
    const tx = response([router], [[]], 'two-swaps');
    const keys = tx.transaction.message.getAccountKeys(),
      indexOf = (key: PublicKey) =>
        keys
          .keySegments()
          .flat()
          .findIndex((value) => value.equals(key));
    const eventAuthority = PublicKey.findProgramAddressSync(
      [Buffer.from('__event_authority')],
      one.programId
    )[0];
    const inner = (instruction: TransactionInstruction) => ({
      programIdIndex: indexOf(instruction.programId),
      accounts: instruction.keys.map((key) => indexOf(key.pubkey)),
      data: bs58.encode(instruction.data),
      stackHeight: 2,
    });
    const events = () =>
      dualFixture.events.map((event) => ({
        programIdIndex: indexOf(one.programId),
        accounts: [indexOf(eventAuthority)],
        data: event.data,
        stackHeight: 3,
      }));
    tx.meta!.innerInstructions![0]!.instructions = [
      inner(one),
      ...events(),
      inner(two),
      ...events(),
    ];
    const trades = decodeTrades(tx, dualFixture.pool);
    expect(trades).toHaveLength(2);
    expect(trades.map((trade) => trade.id)).toEqual(['two-swaps:0:1', 'two-swaps:0:4']);
    const payerIndex = DynamicBondingCurveIdl.instructions
      .find((ix) => ix.name === 'swap2')!
      .accounts.findIndex((a) => a.name === 'payer');
    expect(trades.map((trade) => trade.wallet)).toEqual([
      one.keys[payerIndex]!.pubkey.toBase58(),
      two.keys[payerIndex]!.pubkey.toBase58(),
    ]);
    // Missing execution data must not silently present a one-row result.
    tx.meta!.innerInstructions![0]!.instructions =
      tx.meta!.innerInstructions![0]!.instructions.slice(0, 4);
    expect(() => decodeTrades(tx, dualFixture.pool)).toThrow('missing its executed event');
  });
  it('reads the real DBC dual-event transaction once and supports a genuinely legacy-only event', () => {
    const tx = response(
      [swapInstruction(DYNAMIC_BONDING_CURVE_PROGRAM_ID, new PublicKey(dualFixture.pool))],
      [dualFixture.events.map((event) => Buffer.from(bs58.decode(event.data)))],
      dualFixture.signature
    );
    tx.blockTime = dualFixture.blockTime;
    const trade = decodeTrade(tx, dualFixture.pool, {
      tokenDecimals: 6,
      tokenSupply: 1_000_000_000,
    });
    expect(trade).toMatchObject({ side: 'buy', route: 'dbc', sol: 1, feeSol: 0.9 });
    tx.meta!.innerInstructions![0]!.instructions =
      tx.meta!.innerInstructions![0]!.instructions.slice(0, 1);
    expect(
      decodeTrade(tx, dualFixture.pool, { tokenDecimals: 6, tokenSupply: 1_000_000_000 })
    ).toEqual(trade);
  });
  it('decodes actual DAMM event layout with verified decimals and current post-burn supply', () => {
    const trade = decodeTrade(fixture(), pool.toBase58(), {
      tokenDecimals: 6,
      tokenSupply: 800_000_000,
      migratedBaseIsA: true,
    });
    expect(trade).toMatchObject({
      side: 'buy',
      route: 'damm-v2',
      sol: 1,
      tokens: 987.5,
      feeSol: 0.0125,
      feeSolIsEstimate: false,
    });
    expect(trade?.priceSol).toBeCloseTo(0.001, 12);
    expect(trade?.marketCapSol).toBeCloseTo(800_000, 6);
    expect(
      decodeTrade(fixture(), pool.toBase58(), {
        tokenDecimals: 6,
        tokenSupply: 600_000_000,
        migratedBaseIsA: true,
      })?.marketCapSol
    ).toBeCloseTo(600_000, 6);
  });
  it('preserves reverse-order legacy prices and labels converted token-denominated fees', () => {
    const trade = decodeTrade(fixture(false), pool.toBase58(), {
      tokenDecimals: 6,
      tokenSupply: 800_000_000,
      migratedBaseIsA: false,
    });
    expect(trade?.side).toBe('buy');
    expect(trade?.priceSol).toBeCloseTo(0.001, 12);
    expect(trade?.feeSolIsEstimate).toBe(true);
    expect(trade?.feeSol).toBeCloseTo(0.0125, 12);
  });
  it('requires actual migrated mint ordering and ignores unrelated/failed transactions', () => {
    expect(() => decodeTrade(fixture(), pool.toBase58(), { tokenDecimals: 6 })).toThrow(
      'token order'
    );
    expect(
      decodeTrade(fixture(), Keypair.generate().publicKey.toBase58(), { migratedBaseIsA: true })
    ).toBeNull();
    const failed = fixture();
    failed.meta!.err = { InstructionError: [0, 'InvalidArgument'] };
    expect(decodeTrade(failed, pool.toBase58(), { migratedBaseIsA: true })).toBeNull();
  });
});

import { Connection } from '@solana/web3.js';
import versionOneFixture from './fixtures/mainnet-v1-swap.json';
it('reads a real mainnet version-1 swap through the supported SDK JSON parser', async () => {
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    expect(request.params[1].maxSupportedTransactionVersion).toBe(1);
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: request.id, result: versionOneFixture.response }),
      { headers: { 'content-type': 'application/json' } }
    );
  });
  const connection = new Connection('https://read-only-fixture.invalid', { fetch }),
    signature = versionOneFixture.response.transaction.signatures[0]!,
    tx = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 1,
    });
  expect(tx?.version).toBe(1);
  const rows = decodeTrades(tx!, versionOneFixture.pool, {
    tokenDecimals: 6,
    tokenSupply: 999992084.033075,
    dbcCollectFeeMode: 1,
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ sig: signature, route: 'dbc' });
  expect(rows[0]!.tokens).toBeGreaterThan(0);
  expect(rows[0]!.priceSol).toBeGreaterThan(0);
});
