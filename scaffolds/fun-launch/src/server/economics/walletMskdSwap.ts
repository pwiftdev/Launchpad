import BN from 'bn.js';
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import modePolicy from '@/constants/modePolicy.json';
import { HSOL_REWARD_MINT } from '@/lib/rewards';
import { NETWORK_GENESIS } from '../../../../../scripts/network-policy.cjs';
import {
  HSOL_BRIDGE_POOL,
  MAXIMUM_MSKD_CONVERSION_LAMPORTS,
  mskdConversionPool,
  mskdPayoutMint,
  MSKD_SLIPPAGE_BPS,
  requireFreshMskdQuote,
} from './walletMskdPolicy';
import { WALLET_MEMO_PROGRAM } from './walletEvidence';
import type { WalletExpectations, WalletJob } from './walletTypes';

type DlmmSdk = typeof import('@meteora-ag/dlmm');
type Dlmm = InstanceType<DlmmSdk['default']>;
type Cluster = 'mainnet-beta' | 'devnet';

function instructionRecord(instruction: TransactionInstruction) {
  return {
    program: instruction.programId.toBase58(),
    accounts: instruction.keys.map((key) => key.pubkey.toBase58()),
    dataBase64: instruction.data.toString('base64'),
  };
}

async function loadSwapMarket(
  rpc: Connection,
  pool: PublicKey,
  cluster: Cluster,
  from: PublicKey,
  to: PublicKey,
  outputDecimals: number
) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- The SDK's ESM build imports an unsupported directory.
  const SDK = require('@meteora-ag/dlmm') as DlmmSdk['default'] &
    Pick<DlmmSdk, 'LBCLMM_PROGRAM_IDS'>;
  const market = await rpc.getAccountInfo(pool, 'finalized');
  if (!market?.owner.equals(new PublicKey(SDK.LBCLMM_PROGRAM_IDS[cluster])))
    throw new Error('The pinned MSKD market is not a finalized Meteora DLMM pool');
  const dlmm = await SDK.create(rpc, pool, { cluster });
  const swapForY = dlmm.lbPair.tokenXMint.equals(from);
  const [input, output] = swapForY ? [dlmm.tokenX, dlmm.tokenY] : [dlmm.tokenY, dlmm.tokenX];
  if (
    !input.mint.address.equals(from) ||
    !output.mint.address.equals(to) ||
    !input.owner.equals(TOKEN_PROGRAM_ID) ||
    !output.owner.equals(TOKEN_PROGRAM_ID) ||
    input.mint.decimals !== 9 ||
    output.mint.decimals !== outputDecimals ||
    input.mint.freezeAuthority !== null ||
    output.mint.freezeAuthority !== null
  )
    throw new Error('MSKD market assets differ from the payout policy');
  return { dlmm, swapForY, inputVault: input.reserve, outputVault: output.reserve };
}

function swapAccounts(
  dlmm: Dlmm,
  user: PublicKey,
  userTokenIn: PublicKey,
  userTokenOut: PublicKey
) {
  const { tokenXMint, tokenYMint, reserveX, reserveY, oracle } = dlmm.lbPair;
  return {
    lbPair: dlmm.pubkey,
    reserveX,
    reserveY,
    tokenXMint,
    tokenYMint,
    oracle,
    tokenXProgram: TOKEN_PROGRAM_ID,
    tokenYProgram: TOKEN_PROGRAM_ID,
    user,
    userTokenIn,
    userTokenOut,
    binArrayBitmapExtension: dlmm.binArrayBitmapExtension?.publicKey ?? null,
    hostFeeIn: null as null,
    memoProgram: WALLET_MEMO_PROGRAM,
  };
}

function swapBins(keys: PublicKey[]) {
  if (!keys.length || keys.length > 4)
    throw new Error('MSKD conversion has an unsupported bin array route');
  return keys.map((pubkey) => ({ pubkey, isWritable: true, isSigner: false }));
}

function positiveUnits(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    throw new Error('MSKD conversion requires a positive base-unit amount');
  return new BN(value);
}

async function buildHsolBridge(
  rpc: Connection,
  collector: PublicKey,
  wrappedSol: PublicKey,
  budget: BN,
  existing?: WalletExpectations
) {
  const hsol = new PublicKey(HSOL_REWARD_MINT);
  const { dlmm, swapForY, inputVault, outputVault } = await loadSwapMarket(
    rpc,
    HSOL_BRIDGE_POOL,
    'mainnet-beta',
    hsol,
    NATIVE_MINT,
    9
  );
  const bins = await dlmm.getBinArrayForSwap(swapForY, 4);
  const estimate = dlmm.swapQuote(budget, swapForY, new BN(50), bins, false);
  const amount = existing ? positiveUnits(existing.bridgeAmount) : estimate.minOutAmount;
  const quote = dlmm.swapQuoteExactOut(amount, swapForY, new BN(0), bins);
  if (
    !estimate.consumedInAmount.eq(budget) ||
    amount.lten(0) ||
    amount.lt(estimate.minOutAmount) ||
    !quote.outAmount.eq(amount) ||
    quote.maxInAmount.gt(budget) ||
    !quote.priceImpact.isFinite() ||
    quote.priceImpact.gt(1)
  )
    throw new Error('The reviewed hSOL bridge has insufficient liquidity within the price limit');
  const source = getAssociatedTokenAddressSync(hsol, collector);
  const instruction = await dlmm.program.methods
    .swapExactOut2(budget, amount, { slices: [] })
    .accountsPartial(swapAccounts(dlmm, collector, source, wrappedSol))
    .remainingAccounts(swapBins(quote.binArraysPubkey))
    .instruction();
  return {
    instruction,
    amount,
    expectations: {
      bridgeAmount: amount.toString(),
      bridgePool: HSOL_BRIDGE_POOL.toBase58(),
      bridgeHsolVault: inputVault.toBase58(),
      bridgeWsolVault: outputVault.toBase58(),
      bridgeInstruction: instructionRecord(instruction),
    },
  };
}

export async function buildMskdSwap(
  rpc: Connection,
  collector: PublicKey,
  job: WalletJob,
  existing?: WalletExpectations
) {
  const pool = mskdConversionPool();
  const asset = mskdPayoutMint(job.network_genesis);
  const spend = BigInt(job.lamports);
  const mainnet = job.network_genesis === NETWORK_GENESIS['mainnet-beta'];
  const usesHsol = job.details.sourceMint === HSOL_REWARD_MINT;
  if (
    !pool ||
    !asset ||
    pool.toBase58() !== job.details.market ||
    asset.toBase58() !== job.details.assetMint ||
    spend <= 0n ||
    spend > MAXIMUM_MSKD_CONVERSION_LAMPORTS ||
    (job.details.sourceMint !== undefined && (!usesHsol || !mainnet))
  )
    throw new Error('MSKD conversion requires the pinned markets, mint and quote asset budget');

  const quoteCreatedAt = existing?.quoteCreatedAt ?? Date.now();
  requireFreshMskdQuote(quoteCreatedAt);
  const source = getAssociatedTokenAddressSync(NATIVE_MINT, collector);
  const destination = getAssociatedTokenAddressSync(asset, collector);
  const budget = new BN(spend.toString());
  const [market, bridge] = await Promise.all([
    loadSwapMarket(
      rpc,
      pool,
      mainnet ? 'mainnet-beta' : 'devnet',
      NATIVE_MINT,
      asset,
      modePolicy.payouts.wxmr.decimals
    ),
    usesHsol ? buildHsolBridge(rpc, collector, source, budget, existing) : null,
  ]);
  if (job.kind !== 'wxmr_claim' && (await rpc.getAccountInfo(source, 'finalized')))
    throw new Error('The collector WSOL account must be empty and closed before conversion');
  const { dlmm, swapForY, inputVault } = market;
  const inputAmount = bridge?.amount ?? budget;
  const bins = await dlmm.getBinArrayForSwap(swapForY, 4);
  const quote = dlmm.swapQuote(inputAmount, swapForY, new BN(MSKD_SLIPPAGE_BPS), bins, false);
  if (
    !quote.consumedInAmount.eq(inputAmount) ||
    quote.minOutAmount.lten(0) ||
    !quote.priceImpact.isFinite() ||
    quote.priceImpact.gt(1)
  )
    throw new Error('MSKD conversion has insufficient liquidity within the price limit');
  const minimum = existing ? positiveUnits(existing.minimumPayoutUnits) : quote.minOutAmount;
  if (quote.outAmount.lt(minimum) || minimum.lt(quote.minOutAmount))
    throw new Error('MSKD conversion floor differs from the fresh quote');

  const swap = await dlmm.program.methods
    .swap2(inputAmount, minimum, { slices: [] })
    .accountsPartial(swapAccounts(dlmm, collector, source, destination))
    .remainingAccounts(swapBins(quote.binArraysPubkey))
    .instruction();
  requireFreshMskdQuote(quoteCreatedAt);
  return {
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: bridge ? 550_000 : 400_000 }),
      createAssociatedTokenAccountIdempotentInstruction(collector, source, collector, NATIVE_MINT),
      createAssociatedTokenAccountIdempotentInstruction(collector, destination, collector, asset),
      ...(bridge
        ? [bridge.instruction]
        : [
            SystemProgram.transfer({ fromPubkey: collector, toPubkey: source, lamports: spend }),
            createSyncNativeInstruction(source),
          ]),
      swap,
      createCloseAccountInstruction(source, collector, collector),
    ],
    expectations: {
      collector: collector.toBase58(),
      pool: pool.toBase58(),
      tokenAta: destination.toBase58(),
      quoteAta: source.toBase58(),
      payoutMint: asset.toBase58(),
      minimumPayoutUnits: minimum.toString(),
      maximumSpendLamports: spend.toString(),
      quoteCreatedAt,
      instruction: instructionRecord(swap),
      ...(bridge ? { ...bridge.expectations, payoutWsolVault: inputVault.toBase58() } : {}),
    } satisfies WalletExpectations,
  };
}
