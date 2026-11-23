import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PublicKey, VersionedTransaction, type Connection } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { vaultAddresses, fundingAddress, epochAddress } from '@/lib/vault/client';
import { decodeVaultCoin, decodeVaultSettings } from '@/lib/vault/state';
import discriminators from '@/lib/vault/discriminators.json';
import { messageDigest } from './chainEvidence';

const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const SYSTEM = PublicKey.default;
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const DBC = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
const DAMM = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
const pub = z.string().refine((value) => {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
});
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const amount = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/)
  .refine((value) => BigInt(value) < 1n << 64n);
export const operatorSignerPolicy = z
  .object({
    version: z.literal(1),
    role: z.enum(['operator', 'treasury']),
    networkGenesis: z.literal(MAINNET),
    vaultProgramId: pub,
    deployedProgramDataSha256: hash,
    governor: pub,
    operator: pub,
    treasury: pub,
    upgradeAuthority: pub,
    keyFile: z.string().min(1).max(4096),
    approvedBuybacks: z
      .array(
        z
          .object({
            messageDigest: hash,
            minimumTokens: amount,
            expiresAt: z.number().int().nonnegative().safe(),
          })
          .strict()
      )
      .max(64)
      .default([]),
    rpcUrl: z
      .string()
      .max(4096)
      .url()
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
      }),
    limits: z
      .object({
        maximumFeeLamports: amount,
        maximumFundingLamports: amount,
        maximumBuybackLamports: amount,
        maximumEpochLamports: amount,
        maximumPlatformLamports: amount,
        maximumBuybackLifetimeSeconds: z.number().int().min(1).max(60),
      })
      .strict(),
  })
  .strict();
export type OperatorSignerPolicy = z.infer<typeof operatorSignerPolicy>;
export const operatorSignRequest = z
  .object({
    version: z.literal(1),
    purpose: z.literal('rinsed-financial-sign-only'),
    requestId: hash,
    networkGenesis: z.literal(MAINNET),
    vaultProgramId: pub,
    executionId: z.string().uuid(),
    executionKind: z.enum(['setup', 'funding', 'epoch', 'buyback', 'platform_claim']),
    mint: pub,
    messageDigest: hash,
    feePayer: pub,
    requiredSigners: z.array(pub).length(1),
    lastValidBlockHeight: z.number().int().nonnegative().safe(),
    transactionBase64: z.string().min(1).max(1644),
  })
  .strict();
export type OperatorSignRequest = z.infer<typeof operatorSignRequest>;
export function signRequestId(request: Omit<OperatorSignRequest, 'requestId'>) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'rinsed-external-signer-v1',
        request.networkGenesis,
        request.vaultProgramId,
        request.executionId,
        request.executionKind,
        request.mint,
        request.messageDigest,
        request.feePayer,
        request.requiredSigners,
        request.lastValidBlockHeight,
      ])
    )
    .digest('hex');
}

function requireCondition(value: unknown): asserts value {
  if (!value) throw new Error('Signer policy rejected the request');
}
type Rpc = Pick<
  Connection,
  | 'getGenesisHash'
  | 'getMultipleAccountsInfoAndContext'
  | 'getEpochInfo'
  | 'isBlockhashValid'
  | 'getFeeForMessage'
>;
/** Independently constrain the signing key. No database, private key or broadcast path is used. */
export async function validateOperatorSignRequest(input: unknown, policyInput: unknown, rpc: Rpc) {
  const policy = operatorSignerPolicy.parse(policyInput),
    request = operatorSignRequest.parse(input);
  const expectedSigner = policy.role === 'operator' ? policy.operator : policy.treasury;
  requireCondition(
    request.requestId === signRequestId(request) &&
      request.vaultProgramId === policy.vaultProgramId &&
      request.networkGenesis === policy.networkGenesis &&
      request.feePayer === expectedSigner &&
      request.requiredSigners[0] === expectedSigner
  );
  requireCondition((policy.role === 'treasury') === (request.executionKind === 'platform_claim'));
  const wire = Buffer.from(request.transactionBase64, 'base64');
  requireCondition(wire.length <= 1232 && wire.toString('base64') === request.transactionBase64);
  const tx = VersionedTransaction.deserialize(wire),
    message = tx.message;
  requireCondition(
    messageDigest(message.serialize()) === request.messageDigest &&
      message.header.numRequiredSignatures === 1 &&
      message.header.numReadonlySignedAccounts === 0 &&
      tx.signatures.length === 1 &&
      tx.signatures[0]!.every((byte) => byte === 0) &&
      message.staticAccountKeys[0]?.toBase58() === expectedSigner
  );
  requireCondition(!('addressTableLookups' in message) || message.addressTableLookups.length === 0);
  const mint = new PublicKey(request.mint),
    program = new PublicKey(policy.vaultProgramId),
    addresses = vaultAddresses(program, mint),
    programData = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER)[0];
  requireCondition(
    !program.equals(SYSTEM) &&
      !program.equals(DBC) &&
      !program.equals(DAMM) &&
      !program.equals(TOKEN_PROGRAM_ID) &&
      PublicKey.isOnCurve(new PublicKey(expectedSigner).toBytes())
  );
  requireCondition((await rpc.getGenesisHash()) === MAINNET);
  const bank = await rpc.getEpochInfo({ commitment: 'finalized' });
  requireCondition(
    Number.isSafeInteger(bank.absoluteSlot) &&
      bank.absoluteSlot >= 0 &&
      Number.isSafeInteger(bank.blockHeight) &&
      bank.blockHeight! <= request.lastValidBlockHeight
  );
  const snapshot = await rpc.getMultipleAccountsInfoAndContext(
    [program, programData, addresses.settings, addresses.coin],
    { commitment: 'finalized', minContextSlot: bank.absoluteSlot }
  );
  requireCondition(snapshot.context.slot >= bank.absoluteSlot && snapshot.value.length === 4);
  const [programInfo, dataInfo, settingsInfo, coinInfo] = snapshot.value;
  requireCondition(
    programInfo?.executable &&
      programInfo.owner.equals(LOADER) &&
      programInfo.data.length === 36 &&
      programInfo.data.readUInt32LE(0) === 2 &&
      new PublicKey(programInfo.data.subarray(4, 36)).equals(programData)
  );
  requireCondition(
    dataInfo?.owner.equals(LOADER) &&
      !dataInfo.executable &&
      dataInfo.data.length >= 49 &&
      dataInfo.data.length <= 10 * 1024 * 1024 &&
      dataInfo.data.readUInt32LE(0) === 3 &&
      dataInfo.data[12] === 1 &&
      new PublicKey(dataInfo.data.subarray(13, 45)).toBase58() === policy.upgradeAuthority &&
      createHash('sha256').update(dataInfo.data.subarray(45)).digest('hex') ===
        policy.deployedProgramDataSha256
  );
  requireCondition(
    settingsInfo?.owner.equals(program) &&
      !settingsInfo.executable &&
      settingsInfo.data.length === 107 &&
      coinInfo?.owner.equals(program) &&
      !coinInfo.executable &&
      coinInfo.data.length === 347
  );
  const settings = decodeVaultSettings(settingsInfo!.data),
    coin = decodeVaultCoin(coinInfo!.data);
  requireCondition(
    settings.governor.toBase58() === policy.governor &&
      settings.operator.toBase58() === policy.operator &&
      settings.treasury.toBase58() === policy.treasury &&
      coin.mint.equals(mint)
  );
  requireCondition(request.executionKind === 'platform_claim' || !settings.paused);
  const instructions = message.compiledInstructions;
  requireCondition(instructions.length >= 1 && instructions.length <= 2);
  const at = (index: number) => message.staticAccountKeys[index];
  for (const instruction of instructions) {
    const owner = at(instruction.programIdIndex),
      keys = instruction.accountKeyIndexes.map((index) => at(index)),
      data = Buffer.from(instruction.data);
    requireCondition(keys.every(Boolean) && keys[0]?.toBase58() === expectedSigner);
    const exactKeys = (expected: PublicKey[]) =>
      requireCondition(
        keys.length === expected.length && keys.every((key, index) => key!.equals(expected[index]!))
      );
    const head = (name: keyof typeof discriminators) =>
      data.subarray(0, 8).equals(Buffer.from(discriminators[name]));
    if (owner?.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      requireCondition(
        request.executionKind === 'setup' && data.length === 1 && data[0] === 1 && keys.length === 6
      );
      const tokenMint = keys[3]!;
      requireCondition(tokenMint.equals(NATIVE_MINT) || tokenMint.equals(mint));
      exactKeys([
        new PublicKey(expectedSigner),
        getAssociatedTokenAddressSync(tokenMint, addresses.coin, true),
        addresses.coin,
        tokenMint,
        SYSTEM,
        TOKEN_PROGRAM_ID,
      ]);
      continue;
    }
    requireCondition(owner?.equals(program) && instructions.length === 1);
    if (request.executionKind !== 'platform_claim')
      requireCondition(keys[1]?.equals(addresses.settings));
    if (request.executionKind === 'setup') {
      requireCondition(
        head('bind_migration') &&
          data.length === 8 &&
          keys.length === 8 &&
          keys[2]?.equals(addresses.coin) &&
          keys[3]?.equals(coin.pool) &&
          keys[4]?.equals(coin.config)
      );
    } else if (request.executionKind === 'funding') {
      requireCondition(
        (head('collect_fees') || head('collect_damm_fees') || head('allocate_collected_fees')) &&
          data.length >= 83 &&
          keys[2]?.equals(addresses.coin)
      );
      const count = data.readUInt16LE(72);
      requireCondition(count >= 1 && count <= 32 && data.length === 74 + 9 * count);
      let total = 0n;
      for (let i = 0; i < count; i++) {
        const offset = 74 + 9 * i,
          phase = data[offset],
          net = data.readBigUInt64LE(offset + 1);
        requireCondition((phase === 0 || phase === 1) && net > 0n);
        total += net;
      }
      requireCondition(
        total <= BigInt(policy.limits.maximumFundingLamports) &&
          keys[3]?.equals(fundingAddress(program, addresses.coin, data.subarray(8, 40)))
      );
      if (head('allocate_collected_fees'))
        exactKeys([
          new PublicKey(expectedSigner),
          addresses.settings,
          addresses.coin,
          fundingAddress(program, addresses.coin, data.subarray(8, 40)),
          SYSTEM,
        ]);
      else
        requireCondition(
          keys.length >= 9 &&
            keys[4]?.equals(addresses.quoteAccount) &&
            keys[5]?.equals(addresses.feeAuthority) &&
            keys[6]?.equals(TOKEN_PROGRAM_ID) &&
            keys[7]?.equals(SYSTEM) &&
            keys[8]?.equals(head('collect_fees') ? DBC : DAMM)
        );
    } else if (request.executionKind === 'epoch') {
      requireCondition(head('create_epoch') && data.length === 96 && coin.mode === 'community');
      const epoch = data.readBigUInt64LE(8),
        total = data.readBigUInt64LE(88),
        snapshotSlot = data.readBigUInt64LE(48);
      requireCondition(
        total > 0n &&
          total <= BigInt(policy.limits.maximumEpochLamports) &&
          total <= coin.communityRewards &&
          snapshotSlot <= BigInt(snapshot.context.slot)
      );
      exactKeys([
        new PublicKey(expectedSigner),
        addresses.settings,
        addresses.coin,
        epochAddress(program, addresses.coin, epoch),
        SYSTEM,
      ]);
    } else if (request.executionKind === 'buyback') {
      requireCondition(
        head('execute_buyback_burn') &&
          data.length >= 44 &&
          keys.length >= 8 &&
          keys[2]?.equals(addresses.coin)
      );
      const spend = data.readBigUInt64LE(16),
        minOut = data.readBigUInt64LE(24),
        deadline = data.readBigInt64LE(32),
        route = data[40],
        length = data.readUInt16LE(41);
      requireCondition(
        data.length === 43 + length &&
          length <= 512 &&
          data.readBigUInt64LE(8) === coin.nonce &&
          spend > 0n &&
          spend <= BigInt(policy.limits.maximumBuybackLamports) &&
          spend <= coin.rinseBuyback &&
          minOut > 0n &&
          (route === 0 || route === 1)
      );
      const clock = await rpc.getMultipleAccountsInfoAndContext(
        [new PublicKey('SysvarC1ock11111111111111111111111111111111')],
        { commitment: 'finalized', minContextSlot: snapshot.context.slot }
      );
      const clockData = clock.value[0];
      requireCondition(
        clock.context.slot >= snapshot.context.slot &&
          clockData?.owner.equals(new PublicKey('Sysvar1111111111111111111111111111111111111')) &&
          !clockData.executable &&
          clockData.data.length === 40
      );
      const now = clockData!.data.readBigInt64LE(32);
      requireCondition(
        now >= coin.activationTime + 27n &&
          deadline > now &&
          deadline <= now + BigInt(policy.limits.maximumBuybackLifetimeSeconds)
      );
      // A general spending cap is not a price/slippage proof. Require an independent exact-message
      // approval on the signer host until a separate quote verifier is configured.
      const approvals = policy.approvedBuybacks.filter(
        (value) => value.messageDigest === request.messageDigest
      );
      requireCondition(
        approvals.length === 1 &&
          minOut >= BigInt(approvals[0]!.minimumTokens) &&
          BigInt(approvals[0]!.expiresAt) > now &&
          BigInt(approvals[0]!.expiresAt) <= now + 60n &&
          deadline <= BigInt(approvals[0]!.expiresAt)
      );
      requireCondition(
        keys[3]?.equals(addresses.quoteAccount) &&
          keys[4]?.equals(addresses.tokenAccount) &&
          keys[5]?.equals(mint) &&
          keys[6]?.equals(TOKEN_PROGRAM_ID) &&
          keys[7]?.equals(route === 0 ? DBC : DAMM)
      );
    } else {
      requireCondition(head('claim_platform') && data.length === 16);
      const value = data.readBigUInt64LE(8);
      requireCondition(
        value > 0n &&
          value <= coin.platformFees &&
          value <= BigInt(policy.limits.maximumPlatformLamports)
      );
      exactKeys([new PublicKey(expectedSigner), addresses.coin, addresses.settings]);
    }
  }
  const [finalizedHash, confirmedHash, fee] = await Promise.all([
    rpc.isBlockhashValid(message.recentBlockhash, {
      commitment: 'finalized',
      minContextSlot: snapshot.context.slot,
    }),
    rpc.isBlockhashValid(message.recentBlockhash, {
      commitment: 'confirmed',
      minContextSlot: snapshot.context.slot,
    }),
    rpc.getFeeForMessage(message, 'finalized'),
  ]);
  requireCondition(
    finalizedHash.value &&
      confirmedHash.value &&
      finalizedHash.context.slot >= snapshot.context.slot &&
      confirmedHash.context.slot >= snapshot.context.slot &&
      fee.context.slot >= snapshot.context.slot &&
      Number.isSafeInteger(fee.value) &&
      fee.value! >= 0 &&
      BigInt(fee.value!) <= BigInt(policy.limits.maximumFeeLamports)
  );
  requireCondition((await rpc.getGenesisHash()) === MAINNET);
  return { policy, request, transaction: tx };
}
