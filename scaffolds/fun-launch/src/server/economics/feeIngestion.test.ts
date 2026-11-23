import { describe, it, expect } from 'vitest';
import { BorshCoder, type Idl } from '@coral-xyz/anchor';
import BN from 'bn.js';
import bs58 from 'bs58';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { CpAmmIdl, CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk';
import { decodeFinalizedDammFees } from './feeIngestion';
import { fixtureGenesis, fixtureWallet, transactionFixture } from './financialFixtures';

describe('finalized migrated-pool fees', () => {
  it('classifies the verified flat-fee route as post-RINSE even for an early graduation', async () => {
    const pool = fixtureWallet().publicKey,
      mint = fixtureWallet().publicKey;
    const coder = new BorshCoder(CpAmmIdl as Idl),
      authority = PublicKey.findProgramAddressSync(
        [Buffer.from('__event_authority')],
        CP_AMM_PROGRAM_ID
      )[0];
    const swap = CpAmmIdl.instructions.find((ix) => ix.name === 'swap2')!;
    const test = transactionFixture([
      new TransactionInstruction({
        programId: CP_AMM_PROGRAM_ID,
        keys: [
          { pubkey: pool, isSigner: false, isWritable: true },
          { pubkey: authority, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(swap.discriminator),
      }),
    ]);
    const raw = {
      pool,
      trade_direction: 1,
      collect_fee_mode: 1,
      has_referral: false,
      params: { amount_0: new BN(10000), amount_1: new BN(0), swap_mode: 0 },
      swap_result: {
        included_fee_input_amount: new BN(10000),
        excluded_fee_input_amount: new BN(9875),
        amount_left: new BN(0),
        output_amount: new BN(100),
        next_sqrt_price: new BN(1),
        claiming_fee: new BN(100),
        protocol_fee: new BN(25),
        compounding_fee: new BN(0),
        referral_fee: new BN(0),
      },
      included_transfer_fee_amount_in: new BN(10000),
      included_transfer_fee_amount_out: new BN(100),
      excluded_transfer_fee_amount_out: new BN(100),
      current_timestamp: new BN(1001),
      reserve_a_amount: new BN(10000),
      reserve_b_amount: new BN(10000),
    };
    const authorityIndex = test.accounts.findIndex((key) => key.equals(authority)),
      programIndex = test.accounts.findIndex((key) => key.equals(CP_AMM_PROGRAM_ID));
    const emit = () => {
      const event = coder.types.encode('EvtSwap2', raw);
      test.response.meta!.innerInstructions = [
        {
          index: 0,
          instructions: [
            {
              programIdIndex: programIndex,
              accounts: [authorityIndex],
              data: bs58.encode(
                Buffer.concat([
                  Buffer.from('e445a52e51cb9a1d', 'hex'),
                  Buffer.from(CpAmmIdl.events.find((e) => e.name === 'EvtSwap2')!.discriminator),
                  event,
                ])
              ),
            },
          ],
        },
      ];
    };
    const source = {
      networkGenesis: fixtureGenesis,
      pool: pool.toBase58(),
      mint: mint.toBase58(),
      configKey: fixtureWallet().publicKey.toBase58(),
      activationPoint: 1000,
      mode: 'community' as const,
      programId: CP_AMM_PROGRAM_ID.toBase58(),
    };
    emit();
    const result = decodeFinalizedDammFees(
      await test.evidence(),
      source,
      coder,
      CP_AMM_PROGRAM_ID.toBase58()
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.phase).toBe(1);
    expect(result[0]!.allocation.community).toBe(50n);
    raw.swap_result.compounding_fee = new BN(1);
    emit();
    expect(() =>
      decodeFinalizedDammFees({} as never, source, coder, CP_AMM_PROGRAM_ID.toBase58())
    ).toThrow('independently');
    const proof = await test.evidence();
    expect(() =>
      decodeFinalizedDammFees(proof, source, coder, CP_AMM_PROGRAM_ID.toBase58())
    ).toThrow('Compounding');
  });
});
