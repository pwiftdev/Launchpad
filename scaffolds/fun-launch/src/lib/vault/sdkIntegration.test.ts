import { Connection, Keypair, Transaction } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  DynamicBondingCurveClient,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  deriveDbcPoolAuthority,
  deriveDbcEventAuthority,
  deriveDammV2PoolAuthority,
  deriveDammV2EventAuthority,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CpAmm, CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import { describe, expect, it } from 'vitest';
import { collectFeesInstruction, executeBuybackBurnInstruction, vaultAddresses } from './client';

const connection = new Connection('http://127.0.0.1:8899');
const dbc = new DynamicBondingCurveClient(connection, 'confirmed'),
  damm = new CpAmm(connection);
const program = Keypair.generate().publicKey,
  mint = Keypair.generate().publicKey,
  operator = Keypair.generate().publicKey;
const addresses = vaultAddresses(program, mint),
  pool = Keypair.generate().publicKey,
  config = Keypair.generate().publicKey,
  baseVault = Keypair.generate().publicKey,
  quoteVault = Keypair.generate().publicKey;
const fundingId = 'a'.repeat(64);
const dbcAccounts = {
  poolAuthority: deriveDbcPoolAuthority(),
  config,
  pool,
  baseVault,
  quoteVault,
  baseMint: mint,
  quoteMint: NATIVE_MINT,
  tokenBaseProgram: TOKEN_PROGRAM_ID,
  tokenQuoteProgram: TOKEN_PROGRAM_ID,
  eventAuthority: deriveDbcEventAuthority(),
  program: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
};
describe('actual DEX SDK instructions wrapped by native custody', () => {
  it('wraps the real DBC claim account order and strips impossible outer PDA signatures', async () => {
    const claim = await dbc.partner.program.methods
      .claimTradingFee2(new BN(0), new BN(100), { slices: [] })
      .accountsStrict({
        ...dbcAccounts,
        tokenAAccount: addresses.tokenAccount,
        tokenBAccount: addresses.quoteAccount,
        feeClaimer: addresses.feeAuthority,
      })
      .instruction();
    expect(claim.keys).toHaveLength(14);
    expect(claim.keys[9]?.isSigner).toBe(true);
    const wrapper = collectFeesInstruction({
      programId: program,
      mint,
      operator,
      dexProgram: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
      claimAccounts: claim.keys,
      fundingId,
      commitment: fundingId,
      events: [{ phase: 0, net: 100n }],
    });
    expect(wrapper.keys).toHaveLength(23);
    expect(wrapper.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([
      operator.toBase58(),
    ]);
    expect(wrapper.keys[9 + 2]?.isWritable).toBe(true);
    expect(wrapper.keys[9 + 7]?.isWritable).toBe(false);
    const outer = new Transaction({
      feePayer: operator,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
    }).add(wrapper);
    expect(outer.compileMessage().header.numRequiredSignatures).toBe(1);
    expect(
      outer.serialize({ requireAllSignatures: false, verifySignatures: false }).length
    ).toBeLessThanOrEqual(1232);
  });
  it('preserves the real DAMM readonly pool/mint roles while its position/vaults remain writable', async () => {
    const claim = await damm._program.methods
      .claimPositionFee()
      .accountsStrict({
        poolAuthority: deriveDammV2PoolAuthority(),
        pool,
        position: Keypair.generate().publicKey,
        tokenAAccount: addresses.tokenAccount,
        tokenBAccount: addresses.quoteAccount,
        tokenAVault: baseVault,
        tokenBVault: quoteVault,
        tokenAMint: mint,
        tokenBMint: NATIVE_MINT,
        positionNftAccount: Keypair.generate().publicKey,
        signer: addresses.feeAuthority,
        tokenAProgram: TOKEN_PROGRAM_ID,
        tokenBProgram: TOKEN_PROGRAM_ID,
        eventAuthority: deriveDammV2EventAuthority(),
        program: CP_AMM_PROGRAM_ID,
      })
      .instruction();
    expect(claim.keys).toHaveLength(15);
    expect(claim.keys[1]?.isWritable).toBe(false);
    const wrapper = collectFeesInstruction({
      programId: program,
      mint,
      operator,
      dexProgram: CP_AMM_PROGRAM_ID,
      claimAccounts: claim.keys,
      fundingId,
      commitment: fundingId,
      events: [{ phase: 1, net: 100n }],
      migrated: true,
    });
    expect(wrapper.keys).toHaveLength(24);
    expect(wrapper.keys[10]?.isWritable).toBe(false);
    expect(wrapper.keys[11]?.isWritable).toBe(true);
    expect(wrapper.keys[16]?.isWritable).toBe(false);
    expect(wrapper.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([
      operator.toBase58(),
    ]);
    expect(wrapper.data.subarray(0, 8)).toEqual(Buffer.from([37, 53, 27, 55, 216, 32, 146, 36]));
  });
  it('embeds real DBC exact-input swap bytes without requesting a coin-PDA wallet signature', async () => {
    const swap = await dbc.pool.program.methods
      .swap({ amountIn: new BN(100), minimumAmountOut: new BN(25) })
      .accountsStrict({
        ...dbcAccounts,
        inputTokenAccount: addresses.quoteAccount,
        outputTokenAccount: addresses.tokenAccount,
        payer: addresses.coin,
        referralTokenAccount: null,
      })
      .instruction();
    const wrapper = executeBuybackBurnInstruction({
      programId: program,
      mint,
      operator,
      dexProgram: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
      swapAccounts: swap.keys,
      nonce: 7n,
      amount: 100n,
      minOut: 25n,
      deadline: 10_000n,
      route: 'dbc',
      swapData: swap.data,
    });
    expect(wrapper.keys).toHaveLength(23);
    expect(wrapper.data.subarray(43)).toEqual(swap.data);
    expect(wrapper.data.readBigUInt64LE(8)).toBe(7n);
    expect(wrapper.data.readBigUInt64LE(16)).toBe(100n);
    expect(wrapper.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([
      operator.toBase58(),
    ]);
    expect(wrapper.keys[8 + 3]?.pubkey.equals(addresses.quoteAccount)).toBe(true);
    expect(wrapper.keys[8 + 4]?.pubkey.equals(addresses.tokenAccount)).toBe(true);
  });
  it('embeds real DAMM swap ABI with its distinct 14-account schema', async () => {
    const swap = await damm._program.methods
      .swap({ amountIn: new BN(100), minimumAmountOut: new BN(25) })
      .accountsStrict({
        poolAuthority: deriveDammV2PoolAuthority(),
        pool,
        inputTokenAccount: addresses.quoteAccount,
        outputTokenAccount: addresses.tokenAccount,
        tokenAVault: baseVault,
        tokenBVault: quoteVault,
        tokenAMint: mint,
        tokenBMint: NATIVE_MINT,
        payer: addresses.coin,
        tokenAProgram: TOKEN_PROGRAM_ID,
        tokenBProgram: TOKEN_PROGRAM_ID,
        referralTokenAccount: null,
        eventAuthority: deriveDammV2EventAuthority(),
        program: CP_AMM_PROGRAM_ID,
      })
      .instruction();
    const wrapper = executeBuybackBurnInstruction({
      programId: program,
      mint,
      operator,
      dexProgram: CP_AMM_PROGRAM_ID,
      swapAccounts: swap.keys,
      nonce: 0n,
      amount: 100n,
      minOut: 25n,
      deadline: 10_000n,
      route: 'damm-v2',
      swapData: swap.data,
    });
    expect(wrapper.keys).toHaveLength(22);
    expect(wrapper.data[40]).toBe(1);
    expect(wrapper.data.subarray(43)).toEqual(swap.data);
    expect(wrapper.keys[8 + 1]?.isWritable).toBe(true);
    expect(wrapper.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([
      operator.toBase58(),
    ]);
  });
});
