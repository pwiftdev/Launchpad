import { createHash } from 'node:crypto';
import { BorshCoder, type Idl } from '@coral-xyz/anchor';
import { PublicKey, type Connection, type VersionedTransactionResponse } from '@solana/web3.js';
import {
  CpAmm,
  CpAmmIdl,
  CP_AMM_PROGRAM_ID,
  type PoolState,
  type PositionState,
} from '@meteora-ag/cp-amm-sdk';
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  deriveDammV2PoolAddress,
  derivePositionAddress,
  derivePositionNftAccount,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  unpackAccount,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { vaultAddresses } from '@/lib/vault/client';
import { decodeVaultCoin } from '@/lib/vault/state';
import { configuredVaultProgram } from '../launchConfig';
import { registeredCoin, registeredConfig } from '../launchRegistry';
import { migrationHistoryBoundary } from '../migrationRegistry';
import { assertReleasedMigrationPolicy } from '../damm';
import { DammProofBudget } from './dammProofCapacity';
import {
  sealDammCheckpoint,
  verifyDammCheckpoint,
  type DammCheckpointIdentity,
  type StoredDammCheckpoint,
  type VerifiedDammCheckpoint,
} from './dammCheckpoint';

export type DammCheckpointStore = {
  loadLatest(identity: DammCheckpointIdentity): Promise<StoredDammCheckpoint | null>;
  save(checkpoint: VerifiedDammCheckpoint): Promise<void>;
  loadAttributions(
    identity: DammCheckpointIdentity,
    eventIds: Array<{ signature: string; instructionIndex: number; eventIndex: number }>
  ): Promise<StoredDammCheckpoint[]>;
};

const Q = 1n << 128n,
  MASK = (1n << 256n) - 1n,
  TAG = Buffer.from('e445a52e51cb9a1d', 'hex');
const coder = new BorshCoder(CpAmmIdl as unknown as Idl),
  proofs = new WeakSet<object>();
const integer = (value: unknown) => {
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error('Invalid protocol integer');
  return BigInt(text);
};
const u256 = (bytes: readonly number[]) =>
  BigInt(`0x${Buffer.from(bytes).reverse().toString('hex')}`);
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
export function canonicalSlotOrder(signatures: readonly string[], required: readonly string[]) {
  const ranks = new Map(signatures.map((signature, index) => [signature, index]));
  if (
    ranks.size !== signatures.length ||
    new Set(required).size !== required.length ||
    required.some((signature) => !ranks.has(signature))
  )
    throw new Error('Complete canonical block transaction order is unavailable');
  return ranks;
}
export type DammReplayEvent = {
  name: string;
  data: Record<string, unknown>;
  signature: string;
  instructionIndex?: number;
  eventIndex?: number;
};
function decodeDammHistoryEvents(
  tx: VersionedTransactionResponse,
  pool: string,
  budget: DammProofBudget
) {
  const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta!.loadedAddresses,
    }),
    authority = PublicKey.findProgramAddressSync(
      [Buffer.from('__event_authority')],
      CP_AMM_PROGRAM_ID
    )[0],
    events: DammReplayEvent[] = [];
  for (const group of tx.meta!.innerInstructions ?? [])
    for (const [offset, ix] of group.instructions.entries()) {
      if (!keys.get(ix.programIdIndex)?.equals(CP_AMM_PROGRAM_ID)) continue;
      const bytes = Buffer.from(bs58.decode(ix.data));
      if (!bytes.subarray(0, 8).equals(TAG)) continue;
      if (ix.accounts[0] === undefined || !keys.get(ix.accounts[0])?.equals(authority))
        throw new Error('Untrusted CPAMM event authority');
      const decoded = coder.events.decode(bytes.subarray(8).toString('base64'));
      if (!decoded) throw new Error('Unrecognized actual CPAMM event');
      if (String(decoded.data.pool) === pool)
        events.push({
          name: decoded.name,
          data: decoded.data,
          signature: tx.transaction.signatures[0]!,
          instructionIndex: group.index,
          eventIndex: offset + 1,
        });
      budget.events(events.length);
    }
  return events;
}
async function verifyCheckpointClaimWitness(
  rpc: Connection,
  checkpoint: StoredDammCheckpoint,
  budget: DammProofBudget
) {
  budget.additionalTransactions(1);
  const tx = await rpc.getTransaction(checkpoint.cursorSignature, {
    commitment: 'finalized',
    maxSupportedTransactionVersion: 0,
  });
  if (
    !tx ||
    tx.meta?.err ||
    tx.slot !== checkpoint.cursorSlot ||
    tx.transaction.signatures[0] !== checkpoint.cursorSignature ||
    digest(tx.transaction.message.serialize()) !== checkpoint.payload.cursorMessageDigest
  )
    throw new Error('Authenticated claim checkpoint witness is unavailable or changed');
  const expected = checkpoint.payload.cursorClaimWitness as string[],
    witnessed = decodeDammHistoryEvents(tx, checkpoint.pool, budget),
    claims = witnessed.filter(
      (event) =>
        event.name === 'EvtClaimPositionFee' && String(event.data.position) === checkpoint.position
    );
  budget.additionalEvents(witnessed.length);
  if (
    !Array.isArray(expected) ||
    !expected.length ||
    claims.length !== expected.length ||
    claims.some(
      (claim, index) =>
        integer(claim.data.fee_b_claimed) !== integer(expected[index]) ||
        integer(claim.data.fee_a_claimed) !== 0n
    )
  )
    throw new Error('Claim checkpoint disagrees with actual finalized CPAMM claim witness');
}
export type DammReplayState = {
  liquidity: bigint;
  growth: bigint;
  checkpoint: bigint;
  claimed: bigint;
  raw: bigint;
  external: bigint;
  rounding: bigint;
  roundingBound: bigint;
  eventCount: number;
  windows: number;
  diluted: boolean;
};
export function serializeDammReplayState(state: DammReplayState) {
  return Object.fromEntries(
    Object.entries(state).map(([key, value]) => [
      key,
      typeof value === 'bigint' ? String(value) : value,
    ])
  );
}
export function restoreDammReplayState(value: Record<string, unknown>): DammReplayState {
  const number = (key: string) => {
    const n = value[key];
    if (!Number.isSafeInteger(n) || Number(n) < 0) throw new Error('Invalid checkpoint counter');
    return Number(n);
  };
  if (typeof value.diluted !== 'boolean') throw new Error('Invalid checkpoint liquidity flag');
  return {
    liquidity: integer(value.liquidity),
    growth: integer(value.growth),
    checkpoint: integer(value.checkpoint),
    claimed: integer(value.claimed),
    raw: integer(value.raw),
    external: integer(value.external),
    rounding: integer(value.rounding),
    roundingBound: integer(value.roundingBound),
    eventCount: number('eventCount'),
    windows: number('windows'),
    diluted: value.diluted,
  };
}

/** Exact protocol Q128 growth, with fractional cash retained until each actual claim checkpoint. */
export function replayDammPosition(
  events: DammReplayEvent[],
  position: string,
  ownedLiquidity: bigint,
  budget = new DammProofBudget(),
  seed?: DammReplayState
) {
  const attributions: Array<{
    signature: string;
    instructionIndex: number;
    eventIndex: number;
    raw: bigint;
    realized: bigint;
    externalLpExcluded: bigint;
    roundingLoss: bigint;
    claimSignature: string | null;
  }> = [];
  let windowStart = 0;
  let liquidity = seed?.liquidity ?? 0n,
    growth = seed?.growth ?? 0n,
    checkpoint = seed?.checkpoint ?? 0n,
    claimed = seed?.claimed ?? 0n,
    raw = seed?.raw ?? 0n,
    windowRaw = 0n,
    outsideGrowthQ = 0n,
    truncationQ = 0n;
  let external = seed?.external ?? 0n,
    rounding = seed?.rounding ?? 0n,
    roundingBound = seed?.roundingBound ?? 0n,
    windowEvents = 0,
    eventCount = seed?.eventCount ?? 0,
    windows = seed?.windows ?? 0,
    diluted = seed?.diluted ?? false;
  let completedCheckpoint:
    | { signature: string; state: DammReplayState; attributionCount: number; windowCount: number }
    | undefined;
  if (
    seed &&
    (seed.growth !== seed.checkpoint ||
      seed.raw !== seed.external + seed.rounding + seed.claimed ||
      seed.liquidity < ownedLiquidity)
  )
    throw new Error('Checkpoint is not a closed actual claim state');
  const claims: string[] = [],
    windowsProof: Array<{
      signature: string | null;
      events: number;
      raw: string;
      outsideGrowthQ: string;
      truncationQ: string;
      realized: string;
      external: string;
      rounding: string;
      bound: string;
      eventIdentityDigest?: string;
    }> = [];
  const closeWindow = (signature: string | null) => {
    const actual = (ownedLiquidity * ((growth - checkpoint) & MASK)) / Q,
      excluded = outsideGrowthQ / Q;
    const loss = windowRaw - actual - excluded;
    if (loss < 0n) throw new Error('Protocol fee growth exceeds actual raw fees');
    const bound = ceil(truncationQ, Q) + (outsideGrowthQ > 0n ? 1n : 0n);
    if (loss > bound) throw new Error('Position rounding exceeds the proven window bound');
    external += excluded;
    rounding += loss;
    roundingBound += bound;
    if (windowEvents) {
      let outside = excluded;
      for (const allocation of attributions.slice(windowStart)) {
        const capacity = allocation.raw - allocation.realized,
          portion = outside < capacity ? outside : capacity;
        allocation.externalLpExcluded = portion;
        allocation.roundingLoss = capacity - portion;
        allocation.claimSignature = signature;
        outside -= portion;
      }
      if (outside !== 0n)
        throw new Error('External LP exclusion exceeds actual noncash fee capacity');
      windows++;
      windowsProof.push({
        signature,
        events: windowEvents,
        raw: String(windowRaw),
        outsideGrowthQ: String(outsideGrowthQ),
        truncationQ: String(truncationQ),
        realized: String(actual),
        external: String(excluded),
        rounding: String(loss),
        bound: String(bound),
        eventIdentityDigest: createHash('sha256')
          .update(
            attributions
              .slice(windowStart)
              .map((item) => `${item.signature}:${item.instructionIndex}:${item.eventIndex}`)
              .join('\n')
          )
          .digest('hex'),
      });
    }
    return actual;
  };
  budget.events(events.length);
  for (const [eventOffset, event] of events.entries()) {
    budget.time();
    const d = event.data;
    if (event.name === 'EvtInitializePool') {
      if (liquidity !== 0n) throw new Error('Duplicate pool initialization');
      liquidity = integer(d.liquidity);
      if (liquidity !== ownedLiquidity)
        throw new Error('Original permanent position does not own initial liquidity');
    } else if (event.name === 'EvtLiquidityChange') {
      if (String(d.position) === position)
        throw new Error('The immutable fee position liquidity changed');
      const delta = integer(d.liquidity_delta),
        kind = Number(d.change_type);
      if (kind !== 0 && kind !== 1) throw new Error('Unknown liquidity change');
      liquidity = kind === 0 ? liquidity + delta : liquidity - delta;
      if (liquidity < ownedLiquidity || liquidity >= Q)
        throw new Error('Invalid pool liquidity history');
    } else if (event.name === 'EvtSwap2') {
      if (liquidity <= 0n || Number(d.collect_fee_mode) !== 1)
        throw new Error('Unsupported executed pool fee mode');
      const result = d.swap_result as Record<string, unknown>,
        fee = integer(result.claiming_fee);
      if (integer(result.compounding_fee) !== 0n)
        throw new Error('Compounding is outside reviewed policy');
      const before = (ownedLiquidity * ((growth - checkpoint) & MASK)) / Q;
      const deltaGrowth = (fee * Q) / liquidity;
      growth = (growth + deltaGrowth) & MASK;
      outsideGrowthQ += (liquidity - ownedLiquidity) * deltaGrowth;
      truncationQ += fee * Q - liquidity * deltaGrowth;
      const cash = (ownedLiquidity * ((growth - checkpoint) & MASK)) / Q - before;
      if (cash < 0n || cash > fee) throw new Error('Prefix cash exceeds the actual swap fee');
      attributions.push({
        signature: event.signature,
        instructionIndex: event.instructionIndex ?? 0,
        eventIndex: event.eventIndex ?? attributions.length + 1,
        raw: fee,
        realized: cash,
        externalLpExcluded: 0n,
        roundingLoss: 0n,
        claimSignature: null,
      });
      raw += fee;
      windowRaw += fee;
      windowEvents++;
      eventCount++;
      if (liquidity !== ownedLiquidity) {
        diluted = true;
      }
    } else if (event.name === 'EvtClaimPositionFee' && String(d.position) === position) {
      const amount = closeWindow(event.signature);
      if (integer(d.fee_b_claimed) !== amount || integer(d.fee_a_claimed) !== 0n)
        throw new Error('Actual claim differs from Q128 fee-growth replay');
      claimed += amount;
      checkpoint = growth;
      claims.push(event.signature);
      windowRaw = 0n;
      outsideGrowthQ = 0n;
      truncationQ = 0n;
      windowEvents = 0;
      windowStart = attributions.length;
    } else if (
      ['EvtSplitPosition2', 'EvtSplitPosition3'].includes(event.name) &&
      [d.first_position, d.second_position].some((value) => String(value) === position)
    )
      throw new Error('The immutable fee position was split');
    if (
      events[eventOffset + 1]?.signature !== event.signature &&
      windowEvents === 0 &&
      claims.includes(event.signature)
    ) {
      completedCheckpoint = {
        signature: event.signature,
        state: {
          liquidity,
          growth,
          checkpoint,
          claimed,
          raw,
          external,
          rounding,
          roundingBound,
          eventCount,
          windows,
          diluted,
        },
        attributionCount: attributions.length,
        windowCount: windowsProof.length,
      };
    }
  }
  if (liquidity === 0n) throw new Error('Missing actual pool initialization event');
  const completedExternal = external,
    completedRounding = rounding,
    pending = closeWindow(null);
  if (raw !== external + rounding + claimed + pending)
    throw new Error('Fee realization does not conserve raw protocol fees');
  return {
    liquidity,
    growth,
    checkpoint,
    claimed,
    pending,
    raw,
    external,
    rounding,
    roundingBound,
    eventCount,
    windows,
    claims,
    windowsProof,
    diluted,
    completedExternal,
    completedRounding,
    pendingExternal: external - completedExternal,
    pendingRounding: rounding - completedRounding,
    attributions,
    completedCheckpoint,
  };
}

export async function finalizedPositionClaimable(args: {
  rpc: Connection;
  genesis: string;
  mint: string;
  pool: string;
  programId?: PublicKey;
}) {
  if ((await args.rpc.getGenesisHash()) !== args.genesis)
    throw new Error('Position snapshot network mismatch');
  const identity = await registeredCoin(args.genesis, args.mint),
    programId = args.programId ?? configuredVaultProgram(),
    mint = new PublicKey(args.mint);
  if (!identity || identity.policy_version !== 'rinse-v1')
    throw new Error('Reviewed immutable coin required');
  const config = await registeredConfig(args.genesis, identity.config_key);
  const canonical = deriveDammV2PoolAddress(DAMM_V2_MIGRATION_FEE_ADDRESS[6]!, mint, NATIVE_MINT);
  if (canonical.toBase58() !== args.pool) throw new Error('Wrong canonical migrated pool');
  const addresses = vaultAddresses(programId, mint),
    initial = await args.rpc.getAccountInfo(addresses.coin, 'finalized');
  if (!initial?.owner.equals(programId)) throw new Error('Missing native coin custody');
  const initialCoin = decodeVaultCoin(initial.data),
    response = await args.rpc.getMultipleAccountsInfoAndContext(
      [canonical, initialCoin.position, initialCoin.nftTokenAccount, addresses.coin],
      { commitment: 'finalized' }
    );
  const [poolInfo, positionInfo, nftInfo, coinInfo] = response.value;
  if (
    !poolInfo?.owner.equals(CP_AMM_PROGRAM_ID) ||
    poolInfo.data.length !== 1112 ||
    !positionInfo?.owner.equals(CP_AMM_PROGRAM_ID) ||
    positionInfo.data.length !== 408 ||
    !nftInfo ||
    !coinInfo?.owner.equals(programId)
  )
    throw new Error('Invalid finalized fee accounts');
  const native = decodeVaultCoin(coinInfo.data),
    client = new CpAmm(args.rpc),
    pool = client._program.coder.accounts.decode<PoolState>('pool', poolInfo.data),
    position = client._program.coder.accounts.decode<PositionState>('position', positionInfo.data);
  assertReleasedMigrationPolicy(pool, mint);
  if (
    !config ||
    native.configHash !== config.config_digest ||
    !native.mint.equals(mint) ||
    native.pool.toBase58() !== identity.dbc_pool ||
    native.config.toBase58() !== identity.config_key ||
    !native.migratedPool.equals(canonical) ||
    !native.position.equals(initialCoin.position) ||
    !native.nftTokenAccount.equals(initialCoin.nftTokenAccount) ||
    !position.pool.equals(canonical) ||
    !derivePositionAddress(position.nftMint).equals(native.position) ||
    !derivePositionNftAccount(position.nftMint).equals(native.nftTokenAccount)
  )
    throw new Error('Immutable fee position binding mismatch');
  if (!nftInfo.owner.equals(TOKEN_PROGRAM_ID) && !nftInfo.owner.equals(TOKEN_2022_PROGRAM_ID))
    throw new Error('Invalid position NFT program');
  const nft = unpackAccount(native.nftTokenAccount, nftInfo, nftInfo.owner);
  if (
    !nft.owner.equals(addresses.feeAuthority) ||
    nft.amount !== 1n ||
    !nft.mint.equals(position.nftMint) ||
    !nft.isInitialized ||
    nft.isFrozen ||
    nft.delegate ||
    nft.closeAuthority
  )
    throw new Error('Position fee authority is not exclusive');
  const owned = integer(position.permanentLockedLiquidity),
    total = integer(pool.liquidity);
  if (
    owned <= 0n ||
    !position.unlockedLiquidity.isZero() ||
    !position.vestedLiquidity.isZero() ||
    total < owned ||
    integer(pool.permanentLockLiquidity) < owned
  )
    throw new Error('Invalid permanently owned liquidity');
  const growth = u256(pool.feeBPerLiquidity),
    checkpoint = u256(position.feeBPerTokenCheckpoint),
    amount = integer(position.feeBPending) + (owned * ((growth - checkpoint) & MASK)) / Q;
  return {
    amount,
    slot: response.context.slot,
    owned,
    total,
    growth,
    checkpoint,
    native,
    pool,
    position,
    positionAddress: native.position,
    poolDigest: digest(poolInfo.data),
    positionDigest: digest(positionInfo.data),
    coinDigest: digest(coinInfo.data),
    nftDigest: digest(nftInfo.data),
  };
}

async function history(args: {
  rpc: Connection;
  pool: string;
  slot: number;
  boundary: string;
  maxPages: number;
  budget: DammProofBudget;
  excludeBoundary?: boolean;
  previousDigest?: string;
  boundaryCursor?: { slot: number; transactionIndex: number };
}) {
  const signatures: Array<{ signature: string; slot: number }> = [];
  let before: string | undefined,
    found = false;
  for (let page = 0; page < args.maxPages && !found; page++) {
    args.budget.time();
    const items = await args.rpc.getSignaturesForAddress(
      new PublicKey(args.pool),
      { before, limit: 1000 },
      'finalized'
    );
    for (const item of items) {
      if (item.slot > args.slot) continue;
      if (!item.err) signatures.push(item);
      args.budget.transactions(signatures.length);
      if (item.signature === args.boundary) {
        found = true;
        break;
      }
    }
    if (found || items.length < 1000) break;
    before = items.at(-1)?.signature;
  }
  if (!found) throw new Error('Complete finalized migration-to-snapshot history is unavailable');
  if (new Set(signatures.map((item) => item.signature)).size !== signatures.length)
    throw new Error('Repeated finalized history signature');
  const transactions: VersionedTransactionResponse[] = [];
  for (let i = 0; i < signatures.length; i += 50) {
    args.budget.time();
    const batch = await args.rpc.getTransactions(
      signatures.slice(i, i + 50).map((item) => item.signature),
      { commitment: 'finalized', maxSupportedTransactionVersion: 0 }
    );
    for (let n = 0; n < batch.length; n++) {
      const tx = batch[n],
        expected = signatures[i + n]!;
      if (
        !tx ||
        tx.meta?.err ||
        tx.slot !== expected.slot ||
        tx.transaction.signatures[0] !== expected.signature
      )
        throw new Error('Incomplete finalized LP history');
      transactions.push(tx);
    }
  }
  const actualBoundary = transactions.find((tx) => tx.transaction.signatures[0] === args.boundary);
  if (!actualBoundary) throw new Error('Finalized boundary transaction is unavailable');
  if (args.boundaryCursor) {
    const block = await args.rpc.getBlockSignatures(actualBoundary.slot, 'finalized');
    if (
      !block ||
      actualBoundary.slot !== args.boundaryCursor.slot ||
      canonicalSlotOrder(block.signatures, [args.boundary]).get(args.boundary) !==
        args.boundaryCursor.transactionIndex
    )
      throw new Error('Authenticated checkpoint cursor differs from canonical finalized history');
  }
  const indices = new Map<string, number>(),
    slots = new Map<number, number>();
  for (const tx of transactions) slots.set(tx.slot, (slots.get(tx.slot) ?? 0) + 1);
  for (const [slot, count] of slots)
    if (count > 1) {
      const block = await args.rpc.getBlockSignatures(slot, 'finalized');
      if (!block) throw new Error('Canonical block order is unavailable');
      const ranks = canonicalSlotOrder(
        block.signatures,
        transactions.filter((tx) => tx.slot === slot).map((tx) => tx.transaction.signatures[0]!)
      );
      for (const [signature, index] of ranks) indices.set(signature, index);
    }
  transactions.sort(
    (a, b) =>
      a.slot - b.slot ||
      (indices.get(a.transaction.signatures[0]!) ?? 0) -
        (indices.get(b.transaction.signatures[0]!) ?? 0)
  );
  const events: DammReplayEvent[] = [],
    cursors = new Map<
      string,
      { slot: number; transactionIndex: number; digest: string; messageDigest: string }
    >(),
    authority = PublicKey.findProgramAddressSync(
      [Buffer.from('__event_authority')],
      CP_AMM_PROGRAM_ID
    )[0];
  let decodedEvents = 0;
  let rollingDigest = args.previousDigest ?? digest(Buffer.from('rinsed-damm-history-v1'));
  for (const tx of transactions) {
    if (args.excludeBoundary && tx.transaction.signatures[0] === args.boundary) continue;
    const hash = createHash('sha256')
      .update(rollingDigest)
      .update(String(tx.slot))
      .update(tx.transaction.signatures[0]!);
    hash.update(tx.transaction.message.serialize());
    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta!.loadedAddresses,
    });
    for (const group of tx.meta!.innerInstructions ?? [])
      for (const [eventOffset, ix] of group.instructions.entries()) {
        if (!keys.get(ix.programIdIndex)?.equals(CP_AMM_PROGRAM_ID)) continue;
        const bytes = Buffer.from(bs58.decode(ix.data));
        if (!bytes.subarray(0, 8).equals(TAG)) continue;
        args.budget.events(++decodedEvents);
        if (ix.accounts[0] === undefined || !keys.get(ix.accounts[0])?.equals(authority))
          throw new Error('Untrusted CPAMM event authority');
        const decoded = coder.events.decode(bytes.subarray(8).toString('base64'));
        if (!decoded) throw new Error('Unrecognized actual CPAMM event');
        if (String(decoded.data.pool) !== args.pool) continue;
        events.push({
          name: decoded.name,
          data: decoded.data,
          signature: tx.transaction.signatures[0]!,
          instructionIndex: group.index,
          eventIndex: eventOffset + 1,
        });
        args.budget.events(events.length);
        hash.update(bytes);
      }
    rollingDigest = hash.digest('hex');
    const transactionIndex = indices.get(tx.transaction.signatures[0]!) ?? -1;
    cursors.set(tx.transaction.signatures[0]!, {
      slot: tx.slot,
      transactionIndex,
      digest: rollingDigest,
      messageDigest: digest(tx.transaction.message.serialize()),
    });
  }
  return { events, digest: rollingDigest, transactions: transactions.length, cursors };
}

export type VerifiedDammRealization = {
  networkGenesis: string;
  mint: string;
  pool: string;
  slot: number;
  source: 'position' | 'collected' | 'audit';
  rawExpected: bigint;
  realizedNet: bigint;
  shortfall: bigint;
  externalLpExcluded: bigint;
  roundingLoss: bigint;
  roundingBound: bigint;
  poolDigest: string;
  positionDigest: string;
  digest: string;
  [key: string]: unknown;
};
export function assertDammRealization(proof: VerifiedDammRealization) {
  if (!proofs.has(proof)) throw new Error('Independent finalized DAMM realization proof required');
}
/** Read-only audit also works after all already-realized funds have been allocated. */
export async function auditFinalizedDammPosition(args: {
  rpc: Connection;
  genesis: string;
  mint: string;
  pool: string;
  maxPages?: number;
  programId?: PublicKey;
  checkpointStore?: DammCheckpointStore;
}) {
  const budget = new DammProofBudget();
  const snapshot = await finalizedPositionClaimable(args),
    boundary = await migrationHistoryBoundary(args.genesis, args.mint),
    maxPages = args.maxPages ?? 100;
  if (!boundary || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100)
    throw new Error('Actual migration history boundary is required');
  const checkpointIdentity: DammCheckpointIdentity = {
    networkGenesis: args.genesis,
    programId: (args.programId ?? configuredVaultProgram()).toBase58(),
    mint: args.mint,
    pool: args.pool,
    position: snapshot.positionAddress.toBase58(),
    classificationPolicy: 'q128-growth-v1',
  };
  const stored = await args.checkpointStore?.loadLatest(checkpointIdentity),
    restored = stored ? verifyDammCheckpoint(stored, checkpointIdentity) : undefined;
  if (
    restored &&
    (restored.cursorSlot > snapshot.slot || restored.verifiedSnapshotSlot > snapshot.slot)
  )
    throw new Error('Finalized snapshot precedes authenticated checkpoint');
  const seed = restored
    ? restoreDammReplayState(
        (restored.payload as Record<string, unknown>).state as Record<string, unknown>
      )
    : undefined;
  if (
    restored &&
    ((restored.payload as Record<string, unknown>).ownedLiquidity !== String(snapshot.owned) ||
      (restored.payload as Record<string, unknown>).migrationSignature !== boundary.signature)
  )
    throw new Error('Checkpoint permanent liquidity or migration boundary changed');
  if (restored) await verifyCheckpointClaimWitness(args.rpc, restored, budget);
  const traced = await history({
      rpc: args.rpc,
      pool: args.pool,
      slot: snapshot.slot,
      boundary: restored?.cursorSignature ?? boundary.signature,
      maxPages,
      budget,
      excludeBoundary: !!restored,
      previousDigest: restored?.rollingHistoryDigest,
      boundaryCursor: restored
        ? { slot: restored.cursorSlot, transactionIndex: restored.cursorTransactionIndex }
        : undefined,
    }),
    replay = replayDammPosition(
      traced.events,
      snapshot.positionAddress.toBase58(),
      snapshot.owned,
      budget,
      seed
    );
  if (
    replay.liquidity !== snapshot.total ||
    replay.growth !== snapshot.growth ||
    replay.checkpoint !== snapshot.checkpoint ||
    replay.pending !== snapshot.amount ||
    replay.claimed !== integer(snapshot.position.metrics.totalClaimedBFee) ||
    replay.raw !== integer(snapshot.pool.metrics.totalLpBFee) ||
    !snapshot.position.feeBPending.isZero() ||
    integer(snapshot.pool.metrics.totalLpAFee) !== 0n ||
    integer(snapshot.position.metrics.totalClaimedAFee) !== 0n ||
    !snapshot.position.feeAPending.isZero() ||
    u256(snapshot.pool.feeAPerLiquidity) !== 0n
  )
    throw new Error('Replayed pool/position fees differ from the finalized snapshot');
  if (args.checkpointStore && replay.completedCheckpoint) {
    const candidate = replay.completedCheckpoint,
      cursor = traced.cursors.get(candidate.signature);
    if (!cursor) throw new Error('Checkpoint transaction cursor is missing');
    if (cursor.transactionIndex < 0) {
      const block = await args.rpc.getBlockSignatures(cursor.slot, 'finalized');
      if (!block) throw new Error('Canonical checkpoint block is unavailable');
      cursor.transactionIndex = canonicalSlotOrder(block.signatures, [candidate.signature]).get(
        candidate.signature
      )!;
    }
    const checkpoint = sealDammCheckpoint({
      version: 1,
      ...checkpointIdentity,
      cursorSignature: candidate.signature,
      cursorSlot: cursor.slot,
      cursorTransactionIndex: cursor.transactionIndex,
      payload: {
        state: serializeDammReplayState(candidate.state),
        ownedLiquidity: String(snapshot.owned),
        migrationSignature: boundary.signature,
        cursorMessageDigest: cursor.messageDigest,
        cursorClaimWitness: traced.events
          .filter(
            (event) =>
              event.signature === candidate.signature &&
              event.name === 'EvtClaimPositionFee' &&
              String(event.data.position) === checkpointIdentity.position
          )
          .map((event) => String(event.data.fee_b_claimed)),
        attributions: replay.attributions.slice(0, candidate.attributionCount).map((item) => ({
          ...item,
          raw: String(item.raw),
          realized: String(item.realized),
          externalLpExcluded: String(item.externalLpExcluded),
          roundingLoss: String(item.roundingLoss),
        })),
        windows: replay.windowsProof.slice(0, candidate.windowCount),
      },
      previousCheckpointDigest: restored?.digest ?? null,
      rollingHistoryDigest: cursor.digest,
      verifiedSnapshotSlot: snapshot.slot,
      poolDigest: snapshot.poolDigest,
      positionDigest: snapshot.positionDigest,
    });
    await args.checkpointStore.save(checkpoint);
  }
  return { snapshot, traced, replay, checkpointIdentity, restoredCheckpoint: restored, budget };
}
export async function verifyDammRealization(args: {
  rpc: Connection;
  genesis: string;
  mint: string;
  pool: string;
  rawExpected: bigint;
  eventCount: number;
  eventIds?: Array<{ signature: string; instructionIndex: number; eventIndex: number }>;
  source: 'position' | 'collected' | 'audit';
  collectedAvailable?: bigint;
  accountedRealizedNet?: bigint;
  accountedExternalLpExcluded?: bigint;
  accountedRoundingLoss?: bigint;
  maxPages?: number;
  programId?: PublicKey;
  checkpointStore?: DammCheckpointStore;
}): Promise<VerifiedDammRealization> {
  if (args.source !== 'position' && args.source !== 'collected' && args.source !== 'audit')
    throw new Error('Invalid realization custody source');
  const { snapshot, traced, replay, checkpointIdentity, budget } =
    await auditFinalizedDammPosition(args);
  const accounted = args.accountedRealizedNet ?? 0n,
    externalBefore = args.accountedExternalLpExcluded ?? 0n,
    roundingBefore = args.accountedRoundingLoss ?? 0n;
  const key = (item: { signature: string; instructionIndex: number; eventIndex: number }) =>
    `${item.signature}:${item.instructionIndex}:${item.eventIndex}`;
  const selectedIds = args.eventIds;
  if (
    !selectedIds ||
    selectedIds.length !== args.eventCount ||
    new Set(selectedIds.map(key)).size !== selectedIds.length
  )
    throw new Error('Exact unique selected executed-fee identities are required');
  const byIdentity = new Map(replay.attributions.map((item) => [key(item), item]));
  if (byIdentity.size !== replay.attributions.length)
    throw new Error('Repeated protocol fee event identity');
  const missing = selectedIds.filter((id) => !byIdentity.has(key(id)));
  const missingKeys = new Set(missing.map(key));
  const missingByKey = new Map(missing.map((id) => [key(id), id]));
  const archivedWindows: typeof replay.windowsProof = [];
  if (missing.length && args.checkpointStore) {
    while (missingKeys.size) {
      budget.time();
      const requested = missingKeys.values().next().value!;
      const archives = await args.checkpointStore.loadAttributions(checkpointIdentity, [
        missingByKey.get(requested)!,
      ]);
      if (archives.length !== 1)
        throw new Error('A unique authenticated archived event checkpoint is required');
      const archive = archives[0]!;
      const verified = verifyDammCheckpoint(archive, checkpointIdentity);
      await verifyCheckpointClaimWitness(args.rpc, verified, budget);
      if (verified.verifiedSnapshotSlot > snapshot.slot)
        throw new Error('Archived attribution is ahead of finalized snapshot');
      const payload = verified.payload as Record<string, unknown>;
      budget.additionalEvents((payload.attributions as Array<unknown>).length);
      for (const raw of payload.attributions as Array<Record<string, unknown>>) {
        budget.time();
        const id = {
          signature: String(raw.signature),
          instructionIndex: Number(raw.instructionIndex),
          eventIndex: Number(raw.eventIndex),
        };
        if (!missingKeys.has(key(id))) continue;
        if (byIdentity.has(key(id))) throw new Error('Repeated archived event attribution');
        byIdentity.set(key(id), {
          ...id,
          raw: integer(raw.raw),
          realized: integer(raw.realized),
          externalLpExcluded: integer(raw.externalLpExcluded),
          roundingLoss: integer(raw.roundingLoss),
          claimSignature: String(raw.claimSignature),
        });
        missingKeys.delete(key(id));
      }
      archivedWindows.push(...(payload.windows as typeof replay.windowsProof));
      if (missingKeys.has(requested))
        throw new Error('Archived checkpoint does not contain the requested event');
    }
  }
  const selections = selectedIds.map((id) => {
    const match = byIdentity.get(key(id));
    if (!match) throw new Error('Selected fee event is outside proven protocol history');
    return match;
  });
  const selectedRaw = selections.reduce((sum, item) => sum + item.raw, 0n);
  if (
    args.rawExpected <= 0n ||
    !Number.isInteger(args.eventCount) ||
    args.eventCount < 1 ||
    args.eventCount > replay.eventCount ||
    [accounted, externalBefore, roundingBefore].some((value) => value < 0n) ||
    selectedRaw !== args.rawExpected
  )
    throw new Error('Selected raw fees differ from exact historical event identities');
  const externalLpExcluded = selections.reduce((sum, item) => sum + item.externalLpExcluded, 0n),
    roundingLoss = selections.reduce((sum, item) => sum + item.roundingLoss, 0n);
  const shortfall = externalLpExcluded + roundingLoss,
    realizedNet = selections.reduce((sum, item) => sum + item.realized, 0n),
    available = args.source === 'position' ? snapshot.amount : snapshot.native.unallocatedCollected;
  if (
    args.source === 'collected' &&
    (args.collectedAvailable === undefined || args.collectedAvailable !== available)
  )
    throw new Error('Collected realization must match actual native unallocated custody');
  if (
    args.source !== 'audit' &&
    selections.some((item) =>
      args.source === 'position' ? item.claimSignature !== null : item.claimSignature === null
    )
  )
    throw new Error('Selected fee events belong to a different actual collection window');
  if (args.rawExpected !== realizedNet + shortfall)
    throw new Error('Selected realization does not conserve raw fees');
  if (realizedNet < 0n || (args.source !== 'audit' && realizedNet > available))
    throw new Error('Actual position/collected custody does not cover the realized fee allocation');
  const proof: VerifiedDammRealization = {
    networkGenesis: args.genesis,
    mint: args.mint,
    pool: args.pool,
    slot: snapshot.slot,
    source: args.source,
    classificationPolicy: 'q128-growth-v1',
    zeroCash: realizedNet === 0n,
    rawExpected: args.rawExpected,
    realizedNet,
    shortfall,
    externalLpExcluded,
    roundingLoss,
    roundingBound: replay.roundingBound,
    poolDigest: snapshot.poolDigest,
    positionDigest: snapshot.positionDigest,
    coinDigest: snapshot.coinDigest,
    nftDigest: snapshot.nftDigest,
    rawPoolFees: replay.raw.toString(),
    realizedLifetime: (replay.claimed + replay.pending).toString(),
    accountedRealizedNet: accounted.toString(),
    accountedExternalLpExcluded: externalBefore.toString(),
    accountedRoundingLoss: roundingBefore.toString(),
    fullLPProof: {
      initialOwnedLiquidity: snapshot.owned.toString(),
      currentPoolLiquidity: snapshot.total.toString(),
      currentlyFullOwned: snapshot.owned === snapshot.total,
      externalLiquiditySeen: replay.diluted,
    },
    dilutionPresent: replay.diluted,
    selectedEvents: selections.map((item) => ({
      ...item,
      raw: item.raw.toString(),
      realized: item.realized.toString(),
      externalLpExcluded: item.externalLpExcluded.toString(),
      roundingLoss: item.roundingLoss.toString(),
    })),
    eventIds: selectedIds.map((id) => ({
      signature: id.signature,
      instructionIndex: id.instructionIndex,
      eventIndex: id.eventIndex,
    })),
    selectedEventDigest: createHash('sha256')
      .update(selectedIds.map(key).sort().join('\n'))
      .digest('hex'),
    lossClassification: selections.some((item) => item.claimSignature === null)
      ? 'provisional'
      : 'finalized-claim-window',
    ownershipClassification:
      'floor(non-owned protocol Q128 growth) per actual claim window; not actual outside-wallet payments',
    claimWindowCount: replay.windows,
    claimSignatures: replay.claims,
    windows: [...archivedWindows, ...replay.windowsProof],
    completedExternalLpExcluded: replay.completedExternal.toString(),
    completedRoundingLoss: replay.completedRounding.toString(),
    pendingWindowProvisional: replay.pending > 0n,
    historyDigest: traced.digest,
    historyTransactions: traced.transactions,
    digest: '',
  };
  proof.digest = createHash('sha256')
    .update(
      JSON.stringify(proof, (_, value) => (typeof value === 'bigint' ? value.toString() : value))
    )
    .digest('hex');
  const freeze = (value: unknown): void => {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  freeze(proof);
  proofs.add(proof);
  return proof;
}
