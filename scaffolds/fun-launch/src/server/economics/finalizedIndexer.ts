import { Connection, PublicKey } from '@solana/web3.js';
import { BorshCoder, type Idl } from '@coral-xyz/anchor';
import { CP_AMM_PROGRAM_ID, CpAmmIdl } from '@meteora-ag/cp-amm-sdk';
import { readFinalizedFeeEvidence } from './feeSourceEvidence';
import { decodeFinalizedDbcFees, decodeFinalizedDammFees, type FeeSource } from './feeIngestion';
import type { FinancialStore } from './financialStore';

/** Resumable full history. A scan cap pauses work; it never changes 'partial' into 'complete'. */
export class FinalizedFeeIndexer {
  constructor(
    private readonly rpc: Connection,
    private readonly store: Pick<
      FinancialStore,
      'indexCursor' | 'advanceIndexCursor' | 'ingestFinalizedFees'
    >
  ) {}

  async runPool(
    source: FeeSource,
    input: {
      creationSignature: string | null;
      route: 'dbc' | 'damm-v2';
      maximumPages?: number;
      pageSize?: number;
    }
  ) {
    const pageSize = input.pageSize ?? 50,
      maximumPages = input.maximumPages ?? 4;
    if (
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 1000 ||
      !Number.isSafeInteger(maximumPages) ||
      maximumPages < 1 ||
      maximumPages > 100
    )
      throw new Error('Explicit bounded index work is required');
    if ((await this.rpc.getGenesisHash()) !== source.networkGenesis)
      throw new Error('Index RPC network mismatch');
    let cursor = await this.store.indexCursor(source.networkGenesis, source.pool);
    const damm = input.route === 'damm-v2' ? new BorshCoder(CpAmmIdl as Idl) : null;
    let transactions = 0,
      events = 0;
    for (let page = 0; page < maximumPages; page++) {
      // A completed baseline starts an incremental scan to its previous durable newest signature.
      const starting = !cursor.scan_head_signature;
      const until =
        starting && cursor.complete ? cursor.newest_signature : cursor.scan_until_signature;
      const response = await this.rpc.getSignaturesForAddress(
        new PublicKey(source.pool),
        {
          limit: pageSize,
          before: cursor.scan_before_signature ?? undefined,
        },
        'finalized'
      );
      const head = cursor.scan_head_signature ?? response[0]?.signature ?? cursor.newest_signature;
      let boundaryFound = false,
        last: string | null = null,
        maxSlot = BigInt(cursor.finalized_slot);
      for (const item of response) {
        last = item.signature;
        if (cursor.complete && item.signature === until) {
          boundaryFound = true;
          break;
        }
        if (!item.err) {
          const proof = await readFinalizedFeeEvidence(
            this.rpc,
            source.networkGenesis,
            item.signature
          );
          const decoded = damm
            ? decodeFinalizedDammFees(
                proof,
                { ...source, programId: CP_AMM_PROGRAM_ID.toBase58() },
                damm,
                CP_AMM_PROGRAM_ID.toBase58()
              )
            : decodeFinalizedDbcFees(proof, source);
          events += await this.store.ingestFinalizedFees(decoded);
          transactions++;
          if (BigInt(proof.slot) > maxSlot) maxSlot = BigInt(proof.slot);
        }
        if (!cursor.complete && item.signature === input.creationSignature) {
          boundaryFound = true;
          break;
        }
      }
      const exhausted = response.length < pageSize;
      const finished = boundaryFound;
      if (exhausted && !boundaryFound)
        throw new Error(
          'Creation boundary was not found in available archival history; completeness is unproved'
        );
      cursor = await this.store.advanceIndexCursor({
        ...cursor,
        newest_signature: finished ? head : cursor.newest_signature,
        oldest_signature: !cursor.complete
          ? (last ?? cursor.oldest_signature)
          : cursor.oldest_signature,
        complete: cursor.complete || boundaryFound,
        scan_head_signature: finished ? null : head,
        scan_before_signature: finished ? null : last,
        scan_until_signature: finished ? null : until,
        finalized_slot: maxSlot.toString(),
      });
      if (finished)
        return { transactions, events, complete: cursor.complete, paused: false, cursor };
    }
    return { transactions, events, complete: cursor.complete, paused: true, cursor };
  }
}
