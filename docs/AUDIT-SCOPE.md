# Masked: third-party audit scope

What we are asking an auditor to review before the public relaunch, and what we believe holds. Code
paths are relative to `scaffolds/fun-launch/src/server/economics/` unless stated.

## The system in one paragraph

Every Masked coin trades on Meteora's bonding curve (DBC) and, after graduating, on a DAMM v2 pool.
Each trade pays 1.25%: 0.25% to Meteora, 0.60% to the coin's creator and holders (split by a slider
locked at launch), 0.30% to the company and 0.10% to buy back and burn $MSKD. A company fee wallet
(the collector) claims the fees. A ledger in Postgres records every lamport per coin and per share.
Creators and holders claim everything they earned across all coins on one screen, paid in native XMR
from a Monero treasury, in wXMR while XMR is down, or in SOL. The collector's key lives only in a
separate signing process that rebuilds and checks every transaction before signing it.

## In scope

### 1. Fee claimer and restricted signer

| File                                         | What it does                                                         |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `walletAdapter.ts`                           | Builds collection, buyback, payout, conversion and wXMR transactions |
| `walletSigner.ts`, `externalSigner.ts`       | Signer-side rebuild, limits and refusal rules                        |
| `walletEvidence.ts`, `chainEvidence.ts`      | Proves each finalized effect from chain balances before settling     |
| `walletGate.ts`, `walletSignerConfig.ts`     | Execution gate and signer configuration                              |
| `walletWorker.ts`, `walletExecutionQueue.ts` | Prepare, sign, relay, reconcile and recover                          |
| `walletRecovery.ts`                          | Expiry proofs before a job may be rebuilt                            |
| `scripts/build-financial-worker.mjs` (repo)  | Builds the operator and the separate signer bundles                  |

### 2. Reward engine and ledger

| File                                                   | What it does                                                |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| `feeIngestion.ts`, `finalizedIndexer.ts`               | Reads finalized fee events per pool                         |
| `feeLedger.ts`                                         | Splits each fee into shares; time-weighted holder averaging |
| `holderSnapshot.ts`                                    | Full holder scans used for the five-minute samples          |
| `walletStore.ts`                                       | Ledger writes, reservations, settlement, custody totals     |
| `walletHolderClaims.ts`, `maskedClaimStore.ts`         | One claim across coins; reservations and exact amounts      |
| `walletSignature.ts`, `src/pages/api/earnings.ts`      | Signed claim requests                                       |
| `src/lib/feeModes.ts`, `src/constants/modePolicy.json` | Fee split and the locked creator share                      |

### 3. Treasury and payouts

| File                                         | What it does                                                  |
| -------------------------------------------- | ------------------------------------------------------------- |
| `maskedXmrPayouts.ts`, `moneroWallet.ts`     | Daily XMR batches: price, sign, store, relay, confirm, settle |
| `xmrPrice.ts`                                | Rate locking and rounding toward the treasury                 |
| `moneroSeal.ts`, `src/lib/monero.ts`         | Monero address validation, encryption and erasure             |
| `maskedWxmrClaims.ts`, `walletMskdSwap.ts`   | wXMR swap-and-send payments and their settlement              |
| `maskedBuyback.ts`                           | Moving the 0.10% share to the $MSKD buyback budget            |
| `maskedTreasuryProof.ts`, `../proofStore.ts` | Published view key, key images, and the proof page's totals   |

### 4. Database rules

`scripts/migrations/017`, `019`, `027`, `028` and `035` to `043`: check constraints, immutability
triggers, one-open-job and one-open-claim indexes.

## What we believe holds (please try to break these)

1. **Fees are only counted once they are proven.** Income enters the ledger only from a finalized
   collection whose received SOL is reconstructed from chain balances, never from a signature or an
   RPC claim alone.
2. **The ledger always adds up.** For every coin and share, `funded ≥ reserved + spent`, and the
   collector's SOL covers everything held for payout plus in-flight operating costs before any job
   is signed.
3. **Nothing is paid twice.** A signed transaction is stored before it is relayed, and a retry only
   resends the same bytes. A job is rebuilt only after a proof that its blockhash expired. A Monero
   batch relays only the transactions it stored.
4. **A claim pays exactly what was signed.** The wallet signs the amount, currency and Monero
   address; the server refuses if the claimable amount changed. One open claim per wallet.
5. **Holder rewards follow time held.** Each hour's holder share is split by balances averaged over
   at least six five-minute samples; buying just before a snapshot earns only for the time held.
6. **The signer signs only what it can rebuild.** It refuses any instruction outside the transaction
   it reconstructs from the database row, any stale swap quote, and amounts above its limits.
7. **wXMR payments are all-or-nothing.** Swap and send happen in one transaction; the recipient gets
   exactly the quoted minimum, and settlement checks both balances.
8. **The locked creator share cannot change.** It is fixed per coin at launch.
9. **Monero addresses do not outlive their payout.** They are encrypted at rest and erased when the
   claim settles or fails.
10. **The website holds no private keys.**

## Known limits and open questions

- The XMR exchange rate comes from one price source (CoinGecko), minus a 1% fee.
- The Monero wallet currently uses a remote node.
- wXMR's issuer and the SOL/wXMR market's depth are not yet verified.
- XMR top-ups are bought by hand outside the system.
- The 14-day stagenet rehearsal has not run yet.

## Out of scope

Meteora's programs, Solana and Monero themselves, the front-end's look, and the market-data display
index (it shows data and moves no funds).

## How to run the tests

```bash
pnpm --filter @meteora-invent/scaffold/fun-launch test
```

```bash
node scripts/test-operations.mjs
```
