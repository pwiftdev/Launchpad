> Historical reference: new plzzz.bond launches follow
> [the current Bond it. deployment guide](LIVE-DEPLOYMENT.md). Earlier fee schedules, mode choices
> and native-vault instructions below do not configure new bond-v1 launches.

# Read-only production preflight

`scripts/production-preflight.mjs` checks public deployment facts against independently supplied
expectations. It never deploys, signs, generates keys, broadcasts transactions, updates a database
or opens the mainnet gate. It does not automatically fetch Heroku configuration or load wallet
files. Run it from the reviewed release with its production dependencies installed.

```sh
node scripts/production-preflight.mjs --inventory
node scripts/production-preflight.mjs --expect-public /review/production.public.json
node scripts/production-preflight.mjs --expect-public /review/production.public.json --with-database
```

Without expectations it reports missing inputs and performs no RPC/database checks. Inventory mode
reads only the listed public source files, migrations, frozen schema contract and built worker
artifacts. It does not search private environment files or signing-key directories.

Copy [the public expectations example](production-preflight.example.public.json), then replace each
placeholder from the reviewed release/authority plan. The file must end in `.public.json`, contain
only the allowed public fields, and be at most 32 KiB. It must not contain private keys, secrets or
approval booleans. Missing fields are never filled from observations. In particular, choosing an
observed authority as the expected authority without an independent ownership review proves nothing
about its custody.

## What is checked

- Actual finalized RPC genesis, checked again after the account snapshot. Production requires the
  real mainnet genesis; environment labels alone are insufficient.
- Executable vault/DBC/DAMM/Metaplex programs, canonical protocol addresses, loader/ProgramData PDA
  binding, independently pinned executable-payload hashes and exact upgrade authorities. Use
  explicit `null` for a reviewed immutable program.
- The full DBC config data hash and current policy through the same inspector as
  `audit-launch-config.mjs`, the native exact-config approval, fee-authority PDA, settings PDA,
  governor/operator/treasury and pause state. The canonical migration config also needs its own
  full-data digest. Untrusted off-chain metadata is not read.
- Matching a paused vault or disabled registry is diagnostic only. Separate
  `vault.futureWorkUnpaused` and `config.launchesEnabled` checks must pass for all technical checks
  to pass. Existing funded holder claims have their own verification path; these future-work checks
  do not claim that a pause blocks those claims.
- Public server/client config bindings in the process running the tool, demo exclusion, the closed
  financial gate and worker configuration. These are process observations, not proof of a deployed
  web dyno's environment.
- Independently pinned `.worker/ops.cjs` and `.worker/scheduler.cjs` artifact hashes. Hashes must be
  reviewed after the final normal/standalone packaging build, not copied from an older build.
- With explicit `--with-database`: verified TLS, a repeatable-read **READ ONLY** transaction, schema
  contract, immutable config registry row and matching program/network unsigned-planner heartbeat.
  Database errors and endpoint credentials are withheld from output.

For an upgradeable program, `deployedDataSha256` hashes the entire ProgramData executable payload
after its 45-byte loader metadata, including allocated zero padding. It is not a trimmed ELF hash or
a source-code hash. For a reviewed immutable legacy-loader program it hashes the program account's
executable bytes. A matching hash does not prove an independent audit or reproducible-build review.

For the retained isolated bank's fresh Agave 2.3.13 bootstrap, no `--max-len` was supplied. The
[pinned CLI source](https://github.com/anza-xyz/agave/blob/v2.3.13/cli/src/program.rs#L1396) sets
the initial allocation to the ELF length in that case. This permits an independently reviewed ELF
hash as the expected payload hash for that fresh deployment, provided no later extension or larger
allocation is inferred. A mismatch never causes the tool to replace an expectation with the observed
bank hash.

Worker heartbeat freshness is bounded by the explicitly supplied maximum (at most 300 seconds).
`running`/`completed` state must be recent and have no failed coin operations. `stopped`, `failed`,
missing and stale records fail that check. Even a healthy record proves only the unsigned planner
ran; it does not prove an external signer or transaction relay is available.

## Schema contract

```sh
node scripts/build-production-schema-contract.mjs
```

This development-only generator applies the checked-in migrations to an isolated in-memory
PostgreSQL instance using the existing PGlite test dependency. It reads no real database or private
configuration. Review and commit the generated `scripts/production-schema-contract.json` with its
source migration hashes, then independently pin that artifact's SHA256 in the public expectations.
The production preflight never rebuilds or learns the contract from the database it checks.

Comparison covers required table columns/types/defaults/nullability, exact constraint definitions,
indexes, enabled triggers and stored-function attributes/body hashes. Function bodies are hashed
inside PostgreSQL; their raw contents are not downloaded. Source line endings are normalized to LF.
Newer PostgreSQL versions expose NOT NULL through `pg_constraint`, while PostgreSQL 15 does not;
nullability is checked through column metadata on both. Identical duplicate CHECK constraints from
idempotent migrations are compared once by their exact invariant, while changed definitions or
validation states still fail. SQL whitespace normalization preserves quoted strings/identifiers.
Other drift fails closed with a public category/entry name; it is never silently approved.

The generated contract has also been compared in a READ ONLY transaction with the retained isolated
PostgreSQL 15.19 rehearsal database after migration 016: 34 tables, no differences. Embedded SQL
regressions verify that lost nullability, removed checks and missing immutable triggers are caught.

## Output and limits

Output is structured JSON. Exit 0 means all requested machine checks passed. Exit 2 means missing,
unknown or failing technical checks, including missing/invalid public pins. Exit 1 means invalid
command arguments/files or private connection configuration. `financialReleaseReady` stays false in
every case. Public configuration checks cannot prove signed governance, hardware/multisig custody,
independent security review, external signer liveness, archive-retention promises or production
funded acceptance. The owner approved actual received position income and declined an outside audit
on 28 October; the report records `owner-approved` and `owner-declined` respectively, without
claiming a successful audit or opening the gate. It also records the owner as authority controller
and operational owner. Intended public addresses are recorded in
[the authority record](mainnet-authorities.public.json); actual on-chain binding, custody and
signing still require verification. See [the owner decisions](MAINNET-OWNER-DECISIONS.md).

The optional `--isolated-rehearsal` flag labels the report as rehearsal-only and requires all
existing local-validator guards: nonproduction process, literal loopback configuration and
independently pinned non-live genesis matching the supplied public expectations. It cannot validate
a local fork as production mainnet or open any gate. The retained protocol ledgers are not restarted
by this tool.
