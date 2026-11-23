# Local security and CI changes

No hosting deployment or configuration changes were made for this work.

## Implemented

- Fixed unchecked-index and missing-value paths in board/animation code, watchlist metadata, price
  charts, admin sessions, metadata downloads, market/trending refreshes and whitelist transactions.
  Missing registration rows now abort before commit rather than failing afterward.
- The repository type-check uses the actual ES2022 standard library supported by Node 24; strict
  null/index checks remain enabled. The previous 112 diagnostics were resolved in existing code; the
  final integrated repository type-check is clean.
- Trade display caches include actual decimals/supply, and unavailable/malformed transaction results
  mark the returned history partial. Financial execution uses its separate finalized ledger.
- Upgraded app Zod to the patched v4 line, removed its unused v3 form adapter, upgraded TOML to the
  compatible fixed parser API, and moved Studio/Irys CSV parsing to the fixed release.
- A pnpm-pinned patch forces `bigint-buffer` to use its upstream JavaScript implementation even when
  native bindings exist. Its install hook no longer builds the vulnerable native addon.
- Metro uses the fixed `image-size` v2 buffer parser through a small pinned named-export adaptation.
- Updated the shared TypeScript ESLint parser/plugin to the ESLint 9 compatible version, fixed the
  remaining forbidden require import, and normalized Studio/shared source formatting. Generated
  validator account/key fixtures are excluded from formatting; their contents are unchanged.
- Studio RPC labels display only the origin, and connection failures avoid printing provider paths,
  query credentials or raw provider error messages.
- Web API and SOL-price error logs now use fixed context messages instead of logging provider
  errors, preventing RPC credentials or upstream response bodies from reaching hosting logs.
- Production pages use request-bound script nonces, and admin sessions support explicit epoch/cutoff
  revocation. Uploaded images receive full bounded decoding and static WebP normalization.
- Financial execution uses the native custody program and a durable finalized journal. Recovery
  handles dust-funded uninitialized PDAs, signed-message expiry and proof-bound realized fee
  amounts; owned LP income, outside liquidity and fixed-point rounding remain distinct.
- Launch submission verifies the complete wallet-signed message and saves its public receipt before
  contacting the relay. Browser storage failure blocks broadcast. Receipts are scoped to wallet and
  genesis; a lost relay response stays pending and cannot replace the locally derived signature.
  Registration recovery checks the original transaction without signing another launch. Explicit
  retry requires authenticated preparation, finalized expiry/failure and fresh proof that the mint
  was not initialized. The preparation MAC uses a separate domain under the admin-session secret,
  never a financial checkpoint key. Rotating that secret can prevent old expiry clearance; it does
  not prevent checking the original transaction for registration. No full signed launch wire or mint
  private key is persisted in browser storage.

## Dependency evidence

The production dependency scan fell from 13 findings (7 high) to 5 findings:

| Finding                                 | Runtime treatment                                                                                                                                                                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bigint-buffer` high advisory           | Registry cannot recognize the local patch. Runtime tests force native bindings to be present/hostile and prove they cannot be loaded. All supported byte-width/endian conversions round-trip.                                                                  |
| Three `stream-json` moderate advisories | The actual web3/DBC/DAMM SDK RPC closure uses Jayson browser's JSON parser, not the streaming server parser. A regression blocks every stream-json load and exercises an RPC call with an in-process transport. No incompatible ESM major override was forced. |
| `elliptic` low advisory                 | The observed dependency path is Studio's Irys/Ethereum upload tooling, outside the web financial execution path. An upstream replacement remains necessary for that optional operator tooling.                                                                 |

These findings remain visible in registry audits; they were not hidden with advisory suppressions.
Run `node --test scripts/security-runtime.test.mjs` after dependency changes. CI includes it. The
tests also verify Metro image parsing, Anchor TOML configuration compatibility and Studio/Irys CSV
stream behavior including prototype-shaped headers. They use no network or signer keys.

The locked Rust scan retains all 40 findings: 14 vulnerability entries, 15 unsoundness warnings and
11 maintenance warnings. Pinned SBF target graphs place the vulnerability and unsoundness findings
outside the deployed runtime; `bincode` has one runtime maintenance warning. The scope guard rejects
changed inputs, missing reviewed findings and any runtime vulnerability or unsoundness; it does not
erase native test/tooling risk or grant owner risk acceptance. See
[the versioned Rust review](RUST-DEPENDENCY-REVIEW.md) for exact findings and the expiry policy.

Primary references: [bigint advisory](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg),
[Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5),
[TOML fixed API](https://github.com/BinaryMuse/toml-node/blob/v5.0.1/index.js),
[CSV release compatibility](https://github.com/adaltas/node-csv/blob/master/packages/csv-parse/CHANGELOG.md),
[image-size API change](https://github.com/image-size/image-size/releases/tag/v2.0.0).

## Verification

The final public source archive and reachable local Git patch history were also scanned with the
checksum-verified Gitleaks 8.30.1 release, default rules, full redaction and no project
ignore/baseline or inline-allow suppression. Both source findings were confirmed public values: a
browser storage namespace and the official devnet endpoint/genesis. Both historical findings were
public `configKeyAddress` account addresses. All four findings remain recorded; no unexplained
credential finding remains in that scan. The history tool processed 377 commits and about 181 MB of
patches. Private environment/key files and hosted settings were outside this source scan. Pattern
matching does not prove that credentials never existed elsewhere or establish wallet custody.

The final integrated application suite passed 305 tests across 80 files, with strict TypeScript
checks and lint passing. Dependency alignment, formatting and offline skill/config checks passed.
The five dependency security runtime tests also passed under Linux. Native and compiled-ELF vault
tests passed six cases each; separate real-program local rehearsals cover devnet and actual mainnet
binary snapshots. These tests do not replace independent security review.

The root operations suite also passed 76 automatically discovered regression tests, including
preflight, Rust advisory scope, read-only monitoring and local rollback guards.

The final launch-recovery browser check used an actual isolated-validator submission. Its relay
broadcast successfully, while the browser received an injected HTTP 503. A synchronous browser
snapshot proved the public receipt existed before fetch. Reload recovered the same finalized mint,
verified registration and loaded image, with exactly one wallet transaction signature, metadata
authorization, relay request, chain creation and registry row, and no page errors. The
receipt/status and pending-screen implementation also passed an independent internal review and 36
focused tests. The owner subsequently declined an outside financial-program audit; none is claimed.
See [the decision record](MAINNET-OWNER-DECISIONS.md). Internal evidence does not establish verified
production custody or signer availability.

The Linux Node 24 / pnpm 10.27.0 locked build produced a 31,352,647-byte standalone archive. The
HTTP/security smoke passed again with the original source dependencies hidden. All 25 compiled API
modules, discovered recursively and including the launch receipt-status endpoint, loaded offline
with zero network attempts. Native Sharp WebP processing worked, and the artifact contained none of
the checked env/key/private-fixture files. The archive SHA-256 is
`cf8ca8cb746427901aad175754eef0947828ce7bdbe81fa70847dbb75d6ed8d0`. Its immutable build-input
archive has SHA-256 `07921feecf9d6b3ebb019dba90444e3d3d145366a55bce6fd1e9414484fc89ec` and is
retained separately from the final documentation snapshot. The source-inventory comparator rejects
any non-documentation difference between those archives. The build uses CI placeholder settings and
a devnet public build label; it is release-build evidence, not a configured financial mainnet
deployment. No Heroku deployment or real-network transaction was performed.
