> Historical reference: new plzzz.bond launches follow
> [the current Bond it. deployment guide](LIVE-DEPLOYMENT.md). Earlier fee schedules, mode choices
> and native-vault instructions below do not configure new bond-v1 launches.

# Financial operations (private operator reference)

Financial execution stays closed on mainnet. The local rehearsal uses real Meteora programs cloned
into an isolated validator; it is evidence of behavior, not a public deployment or an independent
audit. Do not publish private manifests, transaction exports, database credentials or signing
material.

## Custody and evidence

The native vault program controls fee rights and enforces spending budgets, immutable recipients,
one-time funding receipts, buyback nonces and Community claim markers. Postgres is a durable index
and workflow journal; a database row cannot create funded SOL. Funding requires independently read,
successful finalized transactions and matching program-owned receipt accounts. SOL donations and
returned token-account rent never automatically become rewards.

The operator remains a trusted attestor of complete fee history, phase assignment and owner
snapshots. Merkle claims prove membership in an operator-approved allocation, not independently
verified historical ownership. Review and separate the operator, program governor, upgrade authority
and treasury roles before production. Neither browser nor web server loads a deployment/operator
private key.

Fees are indexed by genesis, signature, actual instruction/event position and canonical pool. The
compatibility `EvtSwap` and `EvtSwap2` pair from one DBC swap counts once; two separate swaps count
twice. History scans must reach the immutable creation/migration boundary or their previous durable
head. A page limit pauses the scan. Missing archival history blocks completeness and collection.

Funding commits the entire ordered raw event set. Cumulative per-phase integer counters preserve the
same destination totals across collection batches. DAMM claims collect all available position fees;
fees accrued after preparation enter a separate native unallocated counter and require a new
verified event-set commitment before becoming spendable. Arbitrary native transfers cannot increase
that counter. Record funding receipts in native cumulative-counter order.

DAMM raw pool fees are observations, not a promise that every lamport belongs to the program's LP
position. Finalized fee growth and complete swap/liquidity/claim history prove actual owned
proceeds. Cash uses deterministic Q128 prefix deltas inside each actual claim window; later trades
cannot change an earlier event's cash. Commitments bind realized proceeds and their proof. External
LP proceeds and integer rounding never become payable rewards. Definitive category facts are stored
once per closed claim window in `financial_damm_claim_windows`; preparation-time category
assignments are provisional.

## Commands

Build with `node scripts/build-financial-worker.mjs`. Run the resulting
`scaffolds/fun-launch/.worker/ops.cjs` with private operator environment settings. Commands default
to dry run; `--execute` enables journal/unsigned-plan writes. All exports must stay beneath
`.local`.

For a private deployment package, use `node scripts/build-financial-worker.mjs --standalone`, then
`node scripts/operator-artifact-smoke.mjs`. Both operator and scheduler bundles include their
required JavaScript dependencies. The smoke test copies them outside the checkout, disables global
module search and executes help/dry-run paths against a read-only local RPC fixture. It creates no
signature, submits no transaction and needs no database or wallet credential. The generated
`.worker/runtime-manifest.json` records exact bundle hashes; pin the target platform's files in
production preflight. This manifest proves runtime portability, not custody or release approval.

Copy only the reviewed bundles and runtime manifest to the private Node 24 operator host. Supply TLS
configuration and private operator environment there; no `.env`, key file or signer credential is
part of the package. Exports still belong under that working directory's private `.local` folder.
The VM signing fixture is development-only and is not a production signing integration.

| Command                                                               | Purpose                                                                                                          |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `status --mint MINT`                                                  | Read journal balances and recent operator plans.                                                                 |
| `index --mint MINT`                                                   | Resume bounded finalized DBC/DAMM history scans.                                                                 |
| `setup --mint MINT`                                                   | Prepare canonical vault token-account setup separately from financial effects.                                   |
| `prepare-funding --mint MINT`                                         | Reserve an uncollected event set and prepare an unsigned native collection/allocation.                           |
| `prepare-funding --mint MINT --commitment HASH`                       | Resume the same reserved event commitment.                                                                       |
| `prepare-buyback --mint MINT --max-spend-lamports N --slippage-bps N` | Prepare a bounded, expiring quote and atomic purchase/burn.                                                      |
| `snapshot --mint MINT`                                                | Capture all SPL token accounts and prepare Community allocations.                                                |
| `prepare-epoch --mint MINT --epoch N`                                 | Prepare the unsigned native funding of an immutable draft allocation.                                            |
| `relay --id ID --signed-file FILE`                                    | Persist an independently signed exact message before broadcasting.                                               |
| `reconcile --id ID`                                                   | Read finalized success/failure and update the journal once.                                                      |
| `recover-unsigned --id ID`                                            | Prove expiry and unchanged custody before canceling an unsigned buyback or refreshing an unsigned operator plan. |

The local-only `--local-sign-fixture` option uses a separate VM sign-only bridge. It verifies the
isolated genesis on both sides, returns signed bytes without broadcasting, and leaves all role
secrets inside that VM. The host persists those bytes before relay. Production needs a separately
reviewed external signing process. `FINANCIAL_WORKER_ENABLED=true` and the actual expected genesis
are required for relay; the current worker rejects mainnet.

Additional commands are `record-migration --mint MINT --signature SIGNATURE`,
`audit-funding --id ID`, `recover-collected --id ID`, and private
`prepare-platform --mint MINT --amount-lamports N`. Company withdrawals require the fixed treasury's
signature and pay that same treasury. `--pool POOL` selects one canonical funding source when DBC
residual fees coexist with DAMM fees.

The build also produces `scaffolds/fun-launch/.worker/scheduler.cjs`. Its default invocation is a
network-checked dry run. After migrations, a local one-shot is:

```sh
node scaffolds/fun-launch/.worker/scheduler.cjs --execute --cycles 1 --maximum-coins 20
```

For a supervised finite loop, add `--cycles 1000000 --interval-ms 15000`. Limits are 100 coins per
tick, 100 stored receipts per coin and two concurrent coins; defaults are 20/20/one. A dedicated
PostgreSQL session lock prevents overlapping runs for the same genesis/vault. It uses one of the
four pool connections. The persisted cursor advances after each actually attempted bounded batch,
including failed coins, so one broken coin cannot starve the others. A crashed batch can be retried;
the underlying immutable intents and finalized receipt checks provide idempotency.

Discovery includes existing reviewed `rinse-v1` coins even when new launches are disabled. Before
planning a coin, the scheduler independently reconciles its stored signed operator/job receipts.
Unknown, unfinalized or incomplete proofs remain pending and block further planning for that coin;
they never release reservations. The scheduler shares the manual CLI's exact finalized verifier. It
reuses durable unsigned intents, plans account setup and migration binding before collection, and
captures hourly roots only in the real boundary window. Each index/proof/snapshot remains bounded;
missed hourly boundaries roll forward under the existing policy.

Optional `--max-spend-lamports N --slippage-bps N` prepares unsigned buybacks under the existing
worker caps; without an explicit maximum no buyback plan is created. No mode signs, broadcasts,
loads a wallet key, retries a transaction on-chain or withdraws funds. External review/signing and
explicit relay remain separate. Expired unsigned plans still require explicit positive-proof
recovery; the scheduler does not silently replace signed or stale messages. Mainnet planning remains
closed regardless of scheduler flags.

SIGINT/SIGTERM stops new work, interrupts configured RPC fetches and releases the lock. A lost lock
connection also stops the process. A 30-second shutdown deadline terminates stuck work; PostgreSQL
releases its session lock after process death, and a restart reconciles saved state. Any already
running journal operation remains protected by its own one-time commitments/reservations. Per-coin
errors are reduced to fixed statuses; raw provider errors, transaction bytes and private settings
never appear in scheduler output. `financial_scheduler_state` records progress/completion times,
cursor, status and bounded failure counts. This is evidence of unsigned planner activity only;
external signer/relay liveness needs separate monitoring. A completed tick with failed coins must
still alert on its nonzero failure count.

After a user graduates a pool, the planner prepares a separate `prepare-bind-migration` operator
step. The unsigned message pins the actual canonical DAMM pool, permanent fee-authority position and
NFT. Its finalized native binding is verified before collection planning. The user's wallet never
receives the fee authority or operator signing key.

## Hourly Community allocations

Use an actual finalized owner snapshot in the first 60 seconds of a UTC hour, labeled with the
**just-closed** hour (`floor(snapshot.blockTime / 3600) - 1`). The observed finalized bank is the
real cutoff, including its seconds after the boundary; do not pretend it is an exact earlier bank. A
missed window waits for the next real boundary. Do not synthesize historical ownership or backdate
snapshots.

The snapshot reads every standard SPL token account and reconciles their sum to finalized mint
supply in the same bank. It aggregates by wallet and then excludes canonical pool/vault authorities.
The available funded Community budget must already exist by the snapshot slot. Integer dust carries
forward. Draft allocations are immutable, reserved, and unavailable for claims until their native
epoch account is funded and independently verified. Later claim attempts keep the same proof and
one-time wallet marker. Each new marker costs rent paid by the claimant; the interface must show
that cost separately from the reward and network fee.

This release supports direct wallet claims. Off-curve program-address owners are excluded after
their balances enter the complete supply proof; these exclusions enter the snapshot digest.
Custodial/program-held tokens and SPL multisig owners require a separately reviewed claim wrapper
and are unsupported by this interface. An on-curve address alone does not prove user control of a
normal wallet. Do not describe program/custodial balances as automatically claimable.

## Recovery

Always retain the prepared message, signature, last valid block height and reserved amount before
broadcast. A timeout or missing signature status never proves failure. Signed uncertainty keeps its
reservation; rebroadcast only the identical bytes and signature. A proven failed finalized
transaction can release the applicable reservation once. A successful finalized transaction settles
once.

Unsigned buybacks can expire only after finalized height passes the last valid height, the blockhash
is invalid at both confirmed and finalized commitment, the native execution nonce remains unchanged,
and the native budget agrees with the journal's funded-minus-spent balance. Only then cancel and
quote again. Unsigned claims use equivalent checks plus their fixed creator/Community marker custody
rules.

Unsigned funding/epoch/setup plans can refresh only their blockhash after independent expiry proof;
funding/epoch one-time native accounts must still be absent. The old message is archived append-only
before replacement. Instructions, accounts, commitment, recipient and amounts remain unchanged.
Signed uncertain plans cannot use this path. Failed signed operator plans require explicit reviewed
recovery; do not clear a signature or remove a reservation on elapsed time alone.

Narrow DAMM collected-fee recovery requires positive finalized expiry, the old hash invalid at both
commitments, an uninitialized old canonical receipt and actual unallocated custody covering the
proved owned proceeds. The old signed bytes/metadata are archived. A changed amount gets a new
commitment/PDA; raw event reservations transfer atomically without becoming available for another
spend. System-owned empty PDA donations count as uninitialized, matching native creation, and remain
outside reward budgets.

Already-realized DAMM intents preserve their existing commitment/PDA and exact cash amount during
recovery; only collection becomes allocation from verified collected custody. A legacy raw-fee
intent whose proved cash differs receives the new realized commitment described above.

Signed expired Community claims have a separate positive-proof renewal: the actual claim marker is
uninitialized, the hash is invalid at both commitments beyond finalized expiry, and the actual
funded epoch root still proves the same wallet/amount. The old signed attempt is archived; only the
blockhash changes on the same job/entitlement, preserving its reservation. The wallet must
explicitly sign again. A paid marker refuses renewal. Signed uncertain Creator/company withdrawals
require receipt reconciliation or manual review; a timeout never unlocks them.

## Authenticated replay checkpoints

The worker preflights a dedicated `FINANCIAL_CHECKPOINT_HMAC_KEY` (canonical base64, at least 32
random bytes) before preparing or relaying DAMM funding. Keep it outside the web process and
separate from wallet, whitelist and admin secrets. `FINANCIAL_CHECKPOINT_KEY_ID` identifies the
active key; retained old keys in `FINANCIAL_CHECKPOINT_VERIFY_KEYS_JSON` support authenticated
restore during deliberate rotation. Back up the keyring separately from the database. Never silently
replace an invalid key.

Initial bootstrap verifies the complete retained pool history. After an actual closed claim
transaction, the worker writes an immutable authenticated SQL checkpoint. It binds genesis/program,
mint/pool/position, ordered transaction cursor, replay state, account hashes, predecessor and only
new closed-window assignments. Canonical sorted serialization survives PostgreSQL JSONB reordering.
Concurrent checkpoint forks and cursor regression are rejected.

Subsequent proofs verify the MAC, actual retained cursor transaction/message/claim witness and its
canonical block index, then replay the bounded suffix. Older selected raw IDs load exact cash
assignments from authenticated prior checkpoint rows. Current finalized pool/position state must
reconcile; a database row or authenticated file alone is insufficient. Worker restarts and restores
use the same path. Keep an archival RPC capable of serving the required cursor witnesses.

Bootstrap and suffix replay retain transaction/event, integer-arithmetic and elapsed-time limits.
`DAMM_PROOF_CAPACITY_LIMIT` (exit 3) requires preserving the archive and a reviewed capacity upgrade
or recovery from a valid checkpoint. A long lifetime no longer forces a complete rescan; an
oversized uncheckpointed interval remains a deliberate stop. Never skip history or report incomplete
proof as complete.

## Validation and release limits

Automated tests exercise actual isolated SQL constraints, concurrent prepares, integer conservation,
compatibility-event deduplication, complete owner snapshots, exact funding proofs, non-atomic/bad
burns, wrong claim recipients, claim rent accounting, crash/relay uncertainty and unsigned expiry
protections. The isolated real-program rehearsal additionally checks genuine DBC collections, native
receipts, atomic buyback/burn and an actual UTC-boundary epoch. A separate isolated ledger
additionally exercises actual MAINNET protocol binaries, temporary outside LP liquidity, native
graduation binding, zero-owned normalization, creator claims and authenticated checkpoint restore.
Preserve private artifacts and compare native liabilities against funded journal balances
before/after recovery or restore.

The owner declined an outside audit and approved actual received position income; see
[the decision record](MAINNET-OWNER-DECISIONS.md). Mainnet remains gated on verified production
authority/signing setup, protocol compatibility/rehearsal evidence, complete archival RPC history,
working signing/monitoring and funded release acceptance. The owner controls all roles and handles
operations. Intended public addresses are now recorded in
[the authority record](mainnet-authorities.public.json); signing access, custody and host
configuration remain to be verified.
