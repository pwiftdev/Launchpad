# Rust dependency scope review — 28 October 2026

The locked vault dependency scan reports **14 vulnerability entries, 11 unmaintained warnings and 15
unsoundness warnings**. These findings remain visible and unfixed. None of the vulnerability or
unsoundness entries belongs to the conservative normal SBF dependency graph. The deployed program's
graph does include the **bincode 1.3.3 maintenance warning**. This is a technical scope review, not
an independent audit, an owner acceptance of maintenance risk or approval to handle real funds.

## Exact scope and evidence

The unchanged Cargo.lock SHA-256 is
`59885d7e4796bac9d067917c52d81b572992b42654daeb1ef2f03f9f2725b99a`. The scan used official
checksum-verified cargo-audit 0.22.2 and the current RustSec database. The actual pinned v1.53
platform compiler is `rustc 1.89.0-dev`, target `sbpf-solana-solana`, with `target_arch="sbf"` and
`target_os="solana"`.

The collector runs Cargo metadata and independent Cargo trees with `--offline --locked`. It records
normal dependencies, a separate build graph including procedural macros, and the Linux native/test
graph. Host build dependencies and procedural macros cannot be treated as deployed normal code. The
conservative metadata walk contains 107 packages; the independent normal tree contains 100.
Metadata's seven extra feature-unified packages remain in the conservative set. They are not
discarded to obtain a cleaner result. See Cargo's descriptions of
[metadata](https://doc.rust-lang.org/cargo/commands/cargo-metadata.html) and
[tree feature unification and edge kinds](https://doc.rust-lang.org/cargo/commands/cargo-tree.html).

This is package-graph classification, not proof that every function in those packages is reachable
or a complete audit of the external validator/compiler binaries. All financial release gates still
apply. Raw reports and target evidence are retained privately in `.local/rust-dependency-graph`,
`.local/rust-dependency-audit.json` and `.local/rust-advisory-classification.json`; CI retains the
unfiltered report and graphs as an artifact.

## Findings retained

| Package/version                                                                  | Scope                    | Unfixed findings                                                                                              |
| -------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| bincode 1.3.3                                                                    | Normal SBF               | Unmaintained: RUSTSEC-2025-0141. No patched release.                                                          |
| curve25519-dalek 3.2.0                                                           | Native SDK/program tests | Vulnerability: RUSTSEC-2024-0344.                                                                             |
| ed25519-dalek 1.0.1                                                              | Native SDK/program tests | Vulnerability: RUSTSEC-2022-0093.                                                                             |
| h2 0.3.27                                                                        | Native SDK/program tests | Vulnerability: RUSTSEC-2026-0258.                                                                             |
| rustls 0.21.12                                                                   | Native SDK/program tests | Vulnerabilities: RUSTSEC-2026-0346, RUSTSEC-2026-0349.                                                        |
| rustls-webpki 0.101.7                                                            | Native SDK/program tests | Vulnerabilities: RUSTSEC-2026-0098, 0099, 0104, 0382.                                                         |
| webpki-roots 0.24.0 and 0.25.4                                                   | Native SDK/program tests | RUSTSEC-2026-0381 applies to both versions.                                                                   |
| zstd 0.13.3                                                                      | Native SDK/program tests | Vulnerability: RUSTSEC-2026-0391.                                                                             |
| zstd-safe 7.3.0                                                                  | Native SDK/program tests | Vulnerabilities: RUSTSEC-2026-0398, 0403. Ten unsound warnings: RUSTSEC-2026-0395–0397, 0399–0402, 0404–0406. |
| atty 0.2.14                                                                      | Native SDK/program tests | Unmaintained RUSTSEC-2024-0375; unsound RUSTSEC-2021-0145.                                                    |
| im 15.1.0                                                                        | Native SDK/program tests | Unmaintained RUSTSEC-2026-0248; unsound RUSTSEC-2023-0126.                                                    |
| sized-chunks 0.6.5                                                               | Native SDK/program tests | Unmaintained RUSTSEC-2026-0251; unsound RUSTSEC-2026-0255.                                                    |
| memmap2 0.5.10; rand 0.7.3                                                       | Native SDK/program tests | Unsound RUSTSEC-2026-0186; RUSTSEC-2026-0097.                                                                 |
| bitmaps 2.1.0; derivative 2.2.0; libsecp256k1 0.6.0                              | Native SDK/program tests | Unmaintained RUSTSEC-2026-0247; RUSTSEC-2024-0388; RUSTSEC-2025-0161.                                         |
| number_prefix 0.4.0; paste 1.0.15; proc-macro-error2 2.0.1; rustls-pemfile 1.0.4 | Native SDK/program tests | Unmaintained RUSTSEC-2025-0119; RUSTSEC-2024-0436; RUSTSEC-2026-0173; RUSTSEC-2025-0134.                      |

Complete IDs, exact versions and scope reasons are in `scripts/rust-advisory-policy.json`; the
[RustSec advisory database](https://rustsec.org/advisories/) contains their descriptions and fixes.
The test-only findings still matter for developer/CI tooling. Current native tests use isolated
program banks, fake funds and ephemeral test keys. They must not be repurposed as production signing
services or run with production credentials. Dependency upgrades need compatibility testing; no
unsupported major-version override was introduced to hide these entries.

## bincode maintenance warning

The vault's own deserialization calls read the upgradeable loader's Program/ProgramData enum during
initialization, after checking the canonical loader ownership and program-data address. These enum
fields have fixed shapes. The pinned Solana upstream dependencies also use bincode serialization, so
removing only the direct dependency would not remove bincode from the normal graph.
[RustSec classifies this as unmaintained with no patched version](https://rustsec.org/advisories/RUSTSEC-2025-0141.html).
This does not prove all bincode use safe. Retain the maintenance warning and review a supported
upstream serialization migration when changing the Solana toolchain.

## Guard behavior

`scripts/check-rust-advisories.mjs` validates fresh unfiltered scanner output against target
metadata/tree digests and the current Cargo.lock/Cargo.toml. Its classifications expire on 27
November 2026, requiring another technical review; this date grants no financial approval. Changed
versions, newly reported or missing previously reviewed advisories, changed exposure, ignored IDs,
filtered warnings, stale database evidence or inconsistent graphs stop the check. Runtime
vulnerabilities and unsoundness always stop it, even if someone adds a matching classification
entry.

The vault CI workflow collects the exact target graph, runs the checksum-pinned scanner, prints all
findings, applies this scope guard and retains the raw evidence before compiling/testing the
program. Seven adversarial tests cover graph/scope changes, runtime exception attempts, stale inputs
and filtered reports. Passing this guard means the classifications remain supported; it does not
mean the full lockfile is free of advisories.
