import { createHash } from 'node:crypto';
import { BorshCoder, type Idl } from '@coral-xyz/anchor';
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveIdl,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { PublicKey } from '@solana/web3.js';
import { CpAmmIdl } from '@meteora-ag/cp-amm-sdk';
import { type ObservedInstruction } from './chainEvidence';
import { assertFeeEvidence, feeSourceInstructions, type FeeEvidence } from './feeSourceEvidence';
import { usesLaunchSlot } from '@/lib/launchModes';
import { allocateExecutedFee, type FeeAllocation, type LaunchMode } from './feeLedger';

const dbcCoder = new BorshCoder(DynamicBondingCurveIdl as Idl);
const verifiedEvents = new WeakSet<object>();
const EVENT_CPI_TAG = Buffer.from('e445a52e51cb9a1d', 'hex');
export type FeeSource = {
  networkGenesis: string;
  mint: string;
  pool: string;
  configKey: string;
  activationPoint: number;
  mode: LaunchMode;
  programId?: string;
};
export type VerifiedFeeEvent = {
  networkGenesis: string;
  mint: string;
  pool: string;
  signature: string;
  instructionIndex: number;
  eventIndex: number;
  finalizedSlot: number;
  tradeTime: number;
  phase: 0 | 1;
  eventDigest: string;
  total: bigint;
  allocation: FeeAllocation;
};
export const feeEventKey = (
  event: Pick<VerifiedFeeEvent, 'signature' | 'instructionIndex' | 'eventIndex'>
) => `${event.signature}:${event.instructionIndex}:${event.eventIndex}`;
export function assertVerifiedFee(event: VerifiedFeeEvent): void {
  if (!verifiedEvents.has(event))
    throw new Error('Fee events require finalized chain verification');
}

/** One economic event per actual swap invocation, including SDK compatibility dual emissions. */
export function decodeFinalizedDbcFees(
  evidence: FeeEvidence,
  source: FeeSource
): VerifiedFeeEvent[] {
  return decodeFinalizedFees(
    evidence,
    source,
    dbcCoder,
    DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58(),
    'trading_fee'
  );
}

// DAMM's coder/IDL is injected by the migration adapter to avoid adding an implicit app dependency.
export function decodeFinalizedDammFees(
  evidence: FeeEvidence,
  source: FeeSource,
  coder: BorshCoder,
  programId: string
): VerifiedFeeEvent[] {
  if (!source.programId || source.programId !== programId)
    throw new Error('Unreviewed migrated program');
  return decodeFinalizedFees(evidence, source, coder, programId, 'claiming_fee');
}

function decodeFinalizedFees(
  evidence: FeeEvidence,
  source: FeeSource,
  coder: BorshCoder,
  program: string,
  claimField: 'trading_fee' | 'claiming_fee'
): VerifiedFeeEvent[] {
  assertFeeEvidence(evidence);
  if (evidence.networkGenesis !== source.networkGenesis)
    throw new Error('Fee source network mismatch');
  const eventAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    new PublicKey(program)
  )[0].toBase58();
  const idl = claimField === 'trading_fee' ? DynamicBondingCurveIdl : CpAmmIdl;
  const tags = new Set(
    idl.instructions
      .filter((instruction) => instruction.name.startsWith('swap'))
      .map((instruction) => Buffer.from(instruction.discriminator).toString('hex'))
  );
  const currentCalls = new Map<number, ObservedInstruction>();
  const sourceCalls = new Set<string>();
  const canonical = new Map<
    string,
    { ix: ObservedInstruction; data: Record<string, unknown>; v2: boolean; fingerprint: string }
  >();
  const instructions = feeSourceInstructions(evidence).sort(
    (a, b) => a.instructionIndex - b.instructionIndex || a.eventIndex - b.eventIndex
  );
  for (const ix of instructions) {
    if (ix.program !== program) continue;
    if (tags.has(ix.data.subarray(0, 8).toString('hex'))) {
      currentCalls.set(ix.instructionIndex, ix);
      if (ix.accounts.includes(source.pool))
        sourceCalls.add(`${ix.instructionIndex}:${ix.eventIndex}`);
      continue;
    }
    if (ix.eventIndex === 0 || !ix.data.subarray(0, 8).equals(EVENT_CPI_TAG)) continue;
    if (ix.accounts[0] !== eventAuthority) throw new Error('Untrusted program event authority');
    const event = coder.events.decode(ix.data.subarray(8).toString('base64'));
    if (!event || !['EvtSwap', 'evtSwap', 'EvtSwap2', 'evtSwap2'].includes(event.name)) continue;
    const data = event.data as Record<string, unknown>;
    if (String(data.pool) !== source.pool) continue;
    const call = currentCalls.get(ix.instructionIndex);
    if (!call || !call.accounts.includes(source.pool))
      throw new Error('Swap event has no matching authenticated program invocation');
    const raw = data.swap_result as Record<string, unknown> | undefined;
    if (!raw) throw new Error('Unknown executed fee format');
    const fingerprint = JSON.stringify([
      String(data.pool),
      String(data.config ?? ''),
      String(data.trade_direction),
      String(data.current_timestamp),
      ...[claimField, 'protocol_fee', 'referral_fee', 'next_sqrt_price', 'output_amount'].map(
        (key) => String(raw[key])
      ),
    ]);
    const key = `${call.instructionIndex}:${call.eventIndex}`,
      v2 = event.name.toLowerCase().endsWith('2'),
      existing = canonical.get(key);
    if (existing) {
      if (existing.v2 === v2 || existing.fingerprint !== fingerprint)
        throw new Error('Compatibility swap events disagree or repeat the same format');
      if (v2) canonical.set(key, { ix, data, v2, fingerprint });
    } else canonical.set(key, { ix, data, v2, fingerprint });
  }
  if (
    'kind' in evidence &&
    evidence.kind === 'finalized-fee-source' &&
    [...sourceCalls].some((key) => !canonical.has(key))
  )
    throw new Error('Finalized fee source is missing executed swap events');
  const results: VerifiedFeeEvent[] = [];
  for (const { ix, data } of canonical.values()) {
    if (claimField === 'trading_fee' && String(data.config) !== source.configKey)
      throw new Error('Executed pool config differs from immutable registration');
    const raw = data.swap_result as Record<string, { toString(): string }>;
    if (!raw) throw new Error('Unknown executed fee format');
    const amount = (field: string) => {
      const value = raw[field]?.toString();
      if (!value || !/^\d+$/.test(value)) throw new Error('Invalid executed fee amount');
      const result = BigInt(value);
      if (result > 18446744073709551615n) throw new Error('Executed amount exceeds u64');
      return result;
    };
    if (claimField === 'claiming_fee' && amount('compounding_fee') !== 0n)
      throw new Error('Compounding fees are outside the approved fee policy');
    const claimable = amount(claimField),
      protocol = amount('protocol_fee'),
      referral = amount('referral_fee');
    const total = claimable + protocol + referral;
    const tradeTime = Number(String(data.current_timestamp));
    if (
      !Number.isSafeInteger(tradeTime) ||
      tradeTime < 0 ||
      (usesLaunchSlot(source.mode)
        ? evidence.slot < source.activationPoint
        : tradeTime < source.activationPoint)
    )
      throw new Error('Invalid executed trade timestamp');
    // Bond it. follows the actual executed program, never elapsed launch time.
    // Historical RINSE launches retain their original 27-second boundary.
    const phase: 0 | 1 =
      claimField === 'claiming_fee'
        ? 1
        : usesLaunchSlot(source.mode) || tradeTime < source.activationPoint + 27
          ? 0
          : 1;
    const allocation = allocateExecutedFee({
      total,
      protocol,
      referral,
      activationTime: usesLaunchSlot(source.mode) ? 0 : source.activationPoint,
      tradeTime,
      mode: source.mode,
      phase: phase === 0 ? 'rinse' : 'post',
    });
    const result: VerifiedFeeEvent = {
      networkGenesis: evidence.networkGenesis,
      mint: source.mint,
      pool: source.pool,
      signature: evidence.signature,
      instructionIndex: ix.instructionIndex,
      eventIndex: ix.eventIndex,
      finalizedSlot: evidence.slot,
      tradeTime,
      phase,
      eventDigest: createHash('sha256').update(program).update(ix.data).digest('hex'),
      total,
      allocation,
    };
    verifiedEvents.add(result);
    results.push(result);
  }
  return results;
}
