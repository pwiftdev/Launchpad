import { PublicKey, type VersionedTransactionResponse } from '@solana/web3.js';
import { BorshCoder, type Idl } from '@coral-xyz/anchor';
import { CpAmmIdl, CP_AMM_PROGRAM_ID, getFeeMode } from '@meteora-ag/cp-amm-sdk';
import {
  DynamicBondingCurveIdl,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  getPriceFromSqrtPrice,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import BN from 'bn.js';
import bs58 from 'bs58';
import type { Coin, Trade } from '@/lib/coin';
import { TOKEN_DECIMALS, TOTAL_SUPPLY } from '@/constants/launch';

export type TokenContext = Pick<
  Coin,
  'tokenDecimals' | 'tokenSupply' | 'migratedBaseIsA' | 'dbcCollectFeeMode' | 'quoteToSol'
>;
const TAG = Buffer.from('e445a52e51cb9a1d', 'hex');
type Call = {
  program: string;
  migrated: boolean;
  pool: string;
  authority: string;
  input: string;
  instructionIndex: number;
  eventIndex: number;
  depth: number;
  seen: boolean;
};
type Event = { call: Call; data: Record<string, unknown>; modern: boolean; fingerprint: string };
function lastMatching<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (predicate(item)) return item;
  }
  return undefined;
}
function descriptor(idl: Idl) {
  return new Map(
    idl.instructions
      .filter((ix) => ix.name.startsWith('swap'))
      .map((ix) => [
        Buffer.from(ix.discriminator).toString('hex'),
        {
          pool: ix.accounts.findIndex((a) => a.name === 'pool'),
          payer: ix.accounts.findIndex((a) => a.name === 'payer'),
          input: ix.accounts.findIndex((a) => a.name === 'input_token_account'),
        },
      ])
  );
}
const programs = new Map([
  [
    DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58(),
    {
      migrated: false,
      coder: new BorshCoder(DynamicBondingCurveIdl as Idl),
      swaps: descriptor(DynamicBondingCurveIdl as Idl),
    },
  ],
  [
    CP_AMM_PROGRAM_ID.toBase58(),
    { migrated: true, coder: new BorshCoder(CpAmmIdl as Idl), swaps: descriptor(CpAmmIdl as Idl) },
  ],
]);
const num = (value: BN | number | undefined) => {
  if (value === undefined) throw new Error('Missing swap amount');
  const result = Number(value.toString());
  if (!Number.isFinite(result) || result < 0) throw new Error('Invalid swap amount');
  return result;
};

/** All actual swap invocations. Display-only confirmed data never authorizes financial accounting. */
export function decodeTrades(
  tx: VersionedTransactionResponse,
  pool: string,
  token: TokenContext = {}
): Trade[] {
  if (!tx.meta || tx.meta.err) return [];
  const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta.loadedAddresses,
    }),
    events = new Map<string, Event>(),
    calls: Call[] = [];
  let visited = 0;
  const groups = new Map(
    (tx.meta.innerInstructions ?? []).map((group) => [group.index, group.instructions])
  );
  for (const [outer, root] of tx.transaction.message.compiledInstructions.entries()) {
    let active: Call[] = [];
    const visit = (
      programIndex: number,
      indexes: readonly number[],
      data: Buffer,
      eventIndex: number,
      depth?: number
    ) => {
      if (++visited > 4096) throw new Error('Transaction display instruction capacity reached');
      if (depth !== undefined) active = active.filter((call) => call.depth < depth);
      const program = keys.get(programIndex)?.toBase58(),
        description = program ? programs.get(program) : null;
      if (!program || !description) return;
      const swap = description.swaps.get(data.subarray(0, 8).toString('hex'));
      if (swap) {
        const addresses = indexes.map((index) => keys.get(index)?.toBase58());
        const ownPool = addresses[swap.pool],
          authority = addresses[swap.payer],
          input = addresses[swap.input];
        if (!ownPool || !authority || !input)
          throw new Error('Missing actual swap authority or accounts');
        if (depth === undefined) {
          const previous = lastMatching(active, (call) => call.program === program);
          if (previous && !previous.seen)
            throw new Error('Nested swap without sufficient invocation depth');
          active = active.filter((call) => call.program !== program);
        }
        const call = {
          program,
          migrated: description.migrated,
          pool: ownPool,
          authority,
          input,
          instructionIndex: outer,
          eventIndex,
          depth: depth ?? 2,
          seen: false,
        };
        active.push(call);
        calls.push(call);
        return;
      }
      if (eventIndex === 0 || !data.subarray(0, 8).equals(TAG)) return;
      const event = description.coder.events.decode(data.subarray(8).toString('base64'));
      if (!event || !['EvtSwap', 'EvtSwap2'].includes(event.name)) return;
      const value = event.data as Record<string, unknown>;
      if (String(value.pool) !== pool) return;
      const authority = PublicKey.findProgramAddressSync(
        [Buffer.from('__event_authority')],
        new PublicKey(program)
      )[0];
      if (!keys.get(indexes[0] ?? -1)?.equals(authority))
        throw new Error('Invalid swap event authority');
      const call = lastMatching(active, (item) => item.program === program && item.pool === pool);
      if (!call) throw new Error('Swap event has no matching actual invocation');
      call.seen = true;
      const result = value.swap_result as Record<string, unknown> | undefined;
      if (!result) throw new Error('Missing executed swap result');
      const modern = event.name === 'EvtSwap2',
        id = `${outer}:${call.eventIndex}`;
      const fingerprint = JSON.stringify([
        String(value.pool),
        String(value.config ?? ''),
        String(value.trade_direction),
        String(value.current_timestamp),
        ...[
          description.migrated ? 'claiming_fee' : 'trading_fee',
          'protocol_fee',
          'referral_fee',
          'next_sqrt_price',
          'output_amount',
        ].map((field) => String(result[field])),
      ]);
      const previous = events.get(id);
      if (previous && (previous.modern === modern || previous.fingerprint !== fingerprint))
        throw new Error('Duplicate or inconsistent swap compatibility events');
      if (!previous || modern) events.set(id, { call, data: value, modern, fingerprint });
    };
    visit(root.programIdIndex, [...root.accountKeyIndexes], Buffer.from(root.data), 0, 1);
    for (const [index, ix] of (groups.get(outer) ?? []).entries())
      visit(
        ix.programIdIndex,
        ix.accounts,
        Buffer.from(bs58.decode(ix.data)),
        index + 1,
        (ix as typeof ix & { stackHeight?: number | null }).stackHeight ?? undefined
      );
  }
  if (calls.some((call) => call.pool === pool && !call.seen))
    throw new Error('Swap invocation is missing its executed event');
  return [...events.values()].map(({ call, data }) => {
    const r = data.swap_result as Record<string, BN>,
      sqrtPrice = r.next_sqrt_price,
      signature = tx.transaction.signatures[0];
    if (!sqrtPrice || !signature) throw new Error('Incomplete swap event');
    if (call.migrated && token.migratedBaseIsA === undefined)
      throw new Error('Verified graduated token order is required');
    const baseIsA = !call.migrated || token.migratedBaseIsA,
      direction = Number(data.trade_direction),
      isBuy = direction === (baseIsA ? 1 : 0);
    const feeRaw = (call.migrated ? r.claiming_fee : r.trading_fee)!
      .add(r.protocol_fee!)
      .add(r.referral_fee!)
      .add(call.migrated ? r.compounding_fee! : new BN(0));
    const fee = num(feeRaw),
      decimals = token.tokenDecimals ?? TOKEN_DECIMALS;
    const input =
      r.included_fee_input_amount ??
      (r.actual_input_amount && isBuy && (token.dbcCollectFeeMode ?? 0) === 0
        ? r.actual_input_amount.add(feeRaw)
        : r.actual_input_amount);
    const ratio = Number(
        getPriceFromSqrtPrice(sqrtPrice, baseIsA ? decimals : 9, baseIsA ? 9 : decimals).toString()
      ),
      priceSol = baseIsA ? ratio : 1 / ratio;
    if (!Number.isFinite(priceSol) || priceSol <= 0) throw new Error('Invalid executed price');
    const feeOnBase = call.migrated
      ? getFeeMode(Number(data.collect_fee_mode), direction, Boolean(data.has_referral))
          .feesOnTokenA === baseIsA
      : token.dbcCollectFeeMode === 1 && isBuy;
    const owner = [
      ...(tx.meta!.preTokenBalances ?? []),
      ...(tx.meta!.postTokenBalances ?? []),
    ].find((balance) => keys.get(balance.accountIndex)?.toBase58() === call.input)?.owner;
    if (owner) new PublicKey(owner);
    return {
      id: `${signature}:${call.instructionIndex}:${call.eventIndex}`,
      instructionIndex: call.instructionIndex,
      eventIndex: call.eventIndex,
      sig: signature,
      ts: tx.blockTime ?? num(data.current_timestamp as BN),
      side: isBuy ? 'buy' : 'sell',
      wallet: owner ?? call.authority,
      walletRole: owner ? 'token-owner' : 'swap-authority',
      sol: (isBuy ? num(input) : num(r.output_amount)) / 1e9,
      tokens: (isBuy ? num(r.output_amount) : num(input)) / 10 ** decimals,
      feeSol: feeOnBase ? (fee / 10 ** decimals) * priceSol : fee / 1e9,
      feeSolIsEstimate: feeOnBase,
      route: call.migrated ? 'damm-v2' : 'dbc',
      priceSol,
      marketCapSol: priceSol * (token.tokenSupply ?? TOTAL_SUPPLY),
    };
  });
}

/** Compatibility for callers deliberately requesting one swap; history uses decodeTrades. */
export function decodeTrade(
  tx: VersionedTransactionResponse,
  pool: string,
  token: TokenContext = {}
): Trade | null {
  return decodeTrades(tx, pool, token)[0] ?? null;
}
