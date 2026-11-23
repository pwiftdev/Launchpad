# Operational verification

## Migration scope

`node scripts/migrate.mjs` applies the complete ordered schema whenever `DATABASE_URL` is
configured, including when whitelist registration is off. Enabled registration, financial workers or
a configured vault/policy also require storage; missing or invalid storage stops the migration with
a redacted error. The release does not silently skip financial tables when the public whitelist
closes. All migrations run in one advisory-locked transaction. CLI regressions verify whitelist-off
schema application, rollback and error redaction; the same whitelist-off path passed against
isolated TLS Postgres through migration 016.

## Local backup and restore evidence

`scripts/local-backup-drill.sh` accepts no database argument and operates only on the isolated VM's
`rinsed_local` database. It keeps an exported repeatable-read snapshot open while `pg_dump` copies
that exact snapshot, then restores into a new `rinsed_restore_...` database. It never replaces or
deletes the source database. Dump files remain in a private PostgreSQL-owned VM directory.

The final post-closeout snapshot restored to `rinsed_restore_20261028_112037`, from exported
snapshot `00000003-000002BC-1`. Source inventory, dump and restore used verified TLS; only creation
of the new isolated database used the local administrator socket. Every table's count and SHA-256
content inventory matched, with 185 constraints, 63 indexes, 17 application triggers and three
application functions across 34 tables. The snapshot contained nine registered coins, 13 verified
funding receipts, 53 canonical fee events, 11 financial jobs, one reward epoch and three
authenticated replay checkpoints. All three restored checkpoint MACs were independently verified
again. The restored database also passed live rollback-contained checks for immutable launch
identities, append-only fee evidence, the funded reservation cap, duplicate funding receipt
rejection, immutable replay checkpoints and immutable zero-owned fee evidence.
`scripts/local-restore-guards.sql` refuses every database name outside the isolated restore pattern.
The snapshot also includes the durable metadata and upload authorization migrations, with one
consumed upload authorization and two metadata entries, including the actual lost-relay launch.

The final dump hash and comparison inventories are under `.local/final-tls-backup-*` on the host;
the dump itself remains inside the VM. The script can repeat after another rehearsal checkpoint.
This proves a logical restore in the test PostgreSQL cluster. Production backup retention,
off-site/encrypted storage, role/extension recovery and provider point-in-time recovery need a
separate deployment-specific drill before they can be marked verified.

## Local artifact rollback evidence

`scripts/local-artifact-rollback.cjs` accepts only the isolated Linux fixture, fixed artifact
directories and a newly restored `rinsed_restore_...` database. PostgreSQL connections enforce
read-only transactions. It starts the current artifact, a distinct earlier test artifact, and the
current artifact again on the same loopback port 3117, with admin and financial gates closed. Each
phase checks its build manifest, serves the whitelist, reads the real current whitelist schema, and
rejects unauthenticated launch/upload access. Full public schema and all table data hashes must
remain unchanged.

The drill passed against restored database `rinsed_restore_20261028_112037` (34 tables). The current
artifact was `cf8ca8cb746427901aad175754eef0947828ce7bdbe81fa70847dbb75d6ed8d0`, build
`iTFmPbYOQFKSG0nz6UPwp`; the reconstructed earlier artifact was
`670fbcff46f6236b126b6e9c407e29a659d53a9c3a6e1a51d027c019e3cff3dc`, build `3VLg2dH-FVl4e-vjJj54x`.
The earlier source snapshot contains migrations 001–005; the restored database includes 001–016.
This verifies the exercised public read paths across those named versions, not every older financial
operation. The earlier build lacks later security fixes and is **test-only, never an approved
production fallback**.

The current phases also passed live web/database monitoring with no alerts. Their configured public
origin was pinned exactly to the CI build's `https://launch.example`; test transport mapped only
that origin to `127.0.0.1:3117` with the matching Host header. Redirect headers were untouched and
had to match that exact public origin. The versioned evidence is
`.local/artifact-rollback-result.json` and `.local/rollback-artifact-inputs.json`, alongside the
retained previous source/archive and build logs. No deployment, migration rollback, chain
transaction or source database mutation occurred. Production rollback still requires a separately
approved prior release and deployment-specific backup/migration procedure.

## Portable operator artifacts

`node scripts/build-financial-worker.mjs --standalone` builds the operator CLI and unsigned
scheduler without a checkout dependency tree. `node scripts/operator-artifact-smoke.mjs` copies them
outside the checkout, disables global module lookup, and tests both help and dry-run paths against a
local mock that permits only `getGenesisHash`. The Linux run passed with zero signatures and zero
submitted transactions. Its two RPC calls were exactly that read-only method.

The Linux archive `.local/linux-operator-artifact.tar.gz` is 1,440,602 bytes, SHA-256
`d565eed0c16abddcdae2bb780c36a4f4176f0ad084899ffb7551d355a840a0e2`. Its independently checked bundle
hashes are:

| Bundle          | SHA-256                                                            |
| --------------- | ------------------------------------------------------------------ |
| `ops.cjs`       | `b8fb7bfef3f549e3d5a1d438506af1e4d2db234300cad88842b6b1edad39ae02` |
| `scheduler.cjs` | `1af46481dc05c6dcf9207fd9a6261c01de62d805354eb34926fd0e956b145d50` |

The copied `.local/linux-worker-runtime-manifest.json` records the Node/Linux version, hashes,
disabled dependency lookup and exact RPC methods. This is portable runtime evidence; it does not
configure production keys, start a financial worker or approve production custody.

The immutable build input is `.local/linux-build-input.tar.gz`, SHA-256
`07921feecf9d6b3ebb019dba90444e3d3d145366a55bce6fd1e9414484fc89ec`. The final source archive is a
separate post-build snapshot. `scripts/compare-source-archives.cjs` compares every regular file's
content and mode, records exact changed paths, and permits only approved Markdown documentation
changes after the build. Code, policy JSON or runtime changes require a rebuild. The artifact
manifest records both archive hashes separately; `.local/source-provenance.json` contains the
comparison. A documentation refresh is never presented as another compiled build.

## Read-only monitoring

Run `node scripts/web-health.cjs` with the reviewed `NEXT_PUBLIC_SITE_URL`, expected
`WHITELIST_ENABLED` setting and private TLS database configuration. It makes bounded anonymous GETs
to health, whitelist, registration and private-gate endpoints. It checks the actual nonce policy,
headers and exact approved redirect origin; it never sends a cookie or wallet signature. Slow
responses create warnings (`WEB_HEALTH_SLOW_MS`, default 1500). Registration intentionally disabled
is reported explicitly rather than presented as working signup.

When storage is configured, the same command opens a read-only SQL transaction and checks TLS,
required registration tables and database latency. It reports fixed error codes rather than provider
messages or response bodies. Exit code two means a critical check failed; one means the monitor
could not run. Reports remain private operator output. This command does not send notifications;
connect its exit/status output to the production monitoring service and assign a responder.

`--local` permits explicit nonproduction loopback HTTP rehearsals. It does not weaken production
origin checks. Tests include a real stalled HTTP body, which is aborted within the probe deadline.
The live candidate also passed web and TLS database probes during the local rollback drill.

Run `node scripts/financial-health.cjs` from a reviewed checkout using private operator settings:
`DATABASE_URL`, trusted `DATABASE_SSL_CA`, `RPC_URL`, `NEXT_PUBLIC_NETWORK`, and `VAULT_PROGRAM_ID`.
Use a database role with SELECT privileges only. Local rehearsal additionally requires the explicit
local-validator settings and independently pinned genesis. No signing key is needed.

The command uses a read-only repeatable-read database transaction and finalized RPC reads. It prints
job states, index progress, outstanding budget totals and native coin liability checks, without
printing credentials or provider URLs. Its native scan defaults to 100 registered coins;
`FINANCIAL_HEALTH_MAX_COINS` can raise that bound to 1,000. Truncated coverage is reported. Epoch
accounts are outside this coin scan and must use the separate epoch funding and claim verifiers.
Database and RPC observations are not one atomic snapshot.

Exit codes are zero for no critical alert, two for critical alerts, and one for a failed check.
Warnings remain in the JSON even when the exit code is zero. Schedule checks frequently enough to
observe the index and submitted-transaction thresholds; keep full reports in private operator
monitoring, not a public health endpoint.

The final mainnet-binary profile report is `.local/final-mainnet-profile-health.json`. After a
genuine bounded unsigned scheduler cycle and the indexed browser launch, it reported no critical
alerts, 14 finalized operator plans, two deliberately retained unsigned prepared rent setups, three
finalized financial jobs, and three native coin liabilities backed. Five warning entries remain: one
covers the two stale unsigned setups; four cover older paused index scans. The new launch's creation
boundary is complete with no missing cursor. The cycle signed and sent nothing. The separate
original pruned negative fixture is not presented as a healthy complete index. Restarting a paused
test service requires a fresh cycle and health check; this one-shot evidence does not attest that a
production service is running.

| Alert                                                                       | Required response                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manual review or stalled signed/submitted execution                         | Preserve the stored message, signed bytes and signature. Reconcile finalized evidence and expiry before retrying or releasing any reservation. An RPC timeout does not establish transaction failure.                                                                              |
| Incomplete, missing or stale index cursor                                   | Finish the finalized, paginated scan and resolve its creation boundary before preparing funding or holder snapshots.                                                                                                                                                               |
| Index anchor unavailable                                                    | Preserve journal evidence and stop affected new funding. Use an archival RPC to recover the exact missing interval; never reset a cursor or assume an empty truncated history is complete. The local fixture exposed this failure when its initial ledger retention was too small. |
| Native liability shortfall, invalid account or unavailable program/settings | Stop new financial work and investigate the program/account identity and finalized receipts. Use the reviewed governor pause procedure when appropriate; funded claims remain available.                                                                                           |
| Old unsigned prepared execution                                             | Check its validity window and any existing signature before preparing a replacement through the normal durable workflow.                                                                                                                                                           |
| Future vault work paused                                                    | Confirm whether the pause is intentional. Do not infer that already funded claims are disabled.                                                                                                                                                                                    |
| DBC migration rent buffer low/missing                                       | Verify the canonical public DBC global authority account. Its rent reserve fronts pool creation and the migration payer reimburses it afterward. Keep this protocol setup separate from earned fees and vault budgets.                                                             |

## Remaining external checks

Replay checkpoints use a dedicated private operator key, `FINANCIAL_CHECKPOINT_HMAC_KEY` (canonical
base64, at least 32 random bytes), and `FINANCIAL_CHECKPOINT_KEY_ID`. The key must never reuse the
whitelist or admin secret and must stay outside the web process. Planning and checkpoint writes must
validate configuration before any settlement. Whitelist-only mode needs no checkpoint key; an
unconfigured read-only audit can still use complete live history.

For rotation, assign a new key ID and secret, and keep the old ID-to-secret entry in
`FINANCIAL_CHECKPOINT_VERIFY_KEYS_JSON` for every retained checkpoint lineage. Never reuse one key
ID for a different secret. Removing an old key can make history beyond replay capacity unrecoverable
without its archive, so keyring backup/retention is part of operational recovery. The MAC
authenticates cached evidence; it does not replace native receipt/claim-window witnesses or
comparison with the actual finalized pool and position state.

The DAMM fee proof uses authenticated durable checkpoints and replays the suffix after the last
closed claim boundary; archived event selections remain bound to authenticated prior envelopes and
their actual finalized claim witnesses. The actual mainnet-binary run stored three linked
checkpoints and verified both a separate-process restore and an older event after a later
checkpoint. Full replay is still available when no checkpoint exists. Per-pass operating limits are
10,000 fetched transactions, 50,000 decoded events and a 120-second monotonic work budget. Ownership
classification uses the protocol's fixed Q128 fee-growth arithmetic and does not accumulate variable
rational denominators. A limit stops proof issuance and new affected funding with
`DAMM_PROOF_CAPACITY_LIMIT`; it is a capacity failure, not proof of an invalid LP policy. Preserve
archival history, checkpoint keyrings and existing reservations. A single suffix exceeding the
supported work budget needs a reviewed capacity design; increasing limits without review or skipping
history is not recovery. These checks establish controlled rehearsal behavior rather than a
sustained-volume load benchmark.

The ownership replay supports outside LP additions/removals and keeps their fees separate from
integer rounding. Only actual cash earned by the fixed program-owned position becomes funded
budgets. Per-plan classifications can be provisional until their actual claim window closes;
`financial_damm_claim_windows` under `q128-growth-v1` is the definitive closed-window category
record; older classification versions must not be summed with it. Verified zero-owned events are
recorded separately and never create a funding receipt or payable budget. Raw observed fee accrual
and its unfunded gap are not promises of a payable balance.

An independent program/security review has not been performed by this implementation work; the owner
subsequently declined one, as recorded in [the decisions](MAINNET-OWNER-DECISIONS.md). Such a review
would cover the native custody program, DEX CPI validation, atomic purchased-token burn, economic
bounds, immutable funding receipts and epochs, and client/worker serialization. The finalized event
and holder snapshot operator is a trusted attestor; historical ownership is not proved by the vault
program itself. Program and Meteora upgrade authorities remain trust boundaries.

Before mainnet approval, independently verify the actual governor/operator/treasury custody and
recovery process, hardware or multisig signing, upgrade authority and reviewed artifact hashes. Keep
production signer keys outside the web server. Rehearse persisted signed-message recovery before
relay and after a lost RPC response with the actual signing process.

The local VM signing bridge and automated browser wallet are test fixtures. Real Phantom/Solflare
desktop and mobile connections, message authorization, transaction review, rejection, reconnect and
claim recovery still need device checks. A local browser pass cannot establish those results.
