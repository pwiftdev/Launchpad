# RINSED vault program

This native Solana program implements custody for the launchpad's fixed economic policy. The program
ID is supplied by the runtime and is not hardcoded in source. No deployment key or operator private
key belongs in this directory. Mainnet execution stays disabled until the full program, integration
and operational review is complete.

## Authority and trust

- Initialization requires the executable program's actual upgrade authority, verified against the
  canonical upgradeable-loader ProgramData PDA. Being the first caller does not grant control.
- Governor, operator and treasury are fixed at initialization. The governor can pause new work;
  previously funded Creator and Community claims remain available while paused.
- The operator is a **trusted finalized-event and holder-snapshot attestor**. The program does not
  prove historical trade phases or historical token ownership from a Merkle root alone. The server
  must bind complete finalized evidence to each commitment and snapshot root.
- The upgrade authority remains a trust boundary: an upgrade can change program behavior. Review
  custody, upgrade permissions and their eventual restriction separately. Meteora program upgrades
  are also an external dependency; CPI program IDs and account roles are pinned here.

## Custody rules

Configuration approvals are immutable full-account hashes. The approved configuration must use the
intended fee schedule, fixed supply/authority rules, quote-token fees and permanent LP rights.
Registration binds the original creator, mint, pool, configuration and mode in a one-time PDA.
Off-chain metadata and later pool-creator changes cannot redirect those rights.

Trading fees enter through the pinned DEX claim instructions. The global fee-authority PDA signs
only the validated CPI. Native SOL budgets are credited from verified WSOL token receipts, not from
rent refunds or arbitrary donations. Funding receipts are permanent one-time markers and include the
attested commitment, credited total and previous cumulative phase counters. Rounding carries between
funding batches so splitting a batch cannot manufacture or destroy entitlements.

DAMM fee claims collect the entire available position balance. Excess collected over the current
attested batch goes to an explicit unallocated counter, never to a discretionary withdrawal. Later
finalized journal batches can allocate that counter with their own immutable receipts. The DEX route
and static fee settings are verified before treating DAMM fees as post-RINSE.

Buybacks spend only the recorded buyback budget, after the conservative RINSE time boundary. Each
operation has a monotonic nonce, a short deadline, a pool-reserve size cap and a spot-price
minimum-output floor. The pinned swap and SPL burn execute in one instruction. Only the tokens
received by that purchase are burned; pre-existing or donated token balances are preserved.

Community epochs move actual allocated SOL to separate epoch accounts. Roots and snapshot
commitments cannot be replaced. Claims use domain-separated proofs and permanent wallet/epoch
markers; total payouts cannot exceed the epoch's funding. Creator and platform payouts go only to
their fixed recipients and cannot consume another budget, rent or donations.

## ABI and tests

Instruction discriminators and builders are in `scaffolds/fun-launch/src/lib/vault/`.
`state-layout.json` records exact Borsh field offsets and magic values. Rust `State::SPACE`
constants are authoritative and account loads reject an incorrect owner, magic or length.

```sh
cargo check --locked --all-targets
cargo test --locked -- --test-threads=1
cargo build-sbf --tools-version v1.53 -- --locked
RINSED_TEST_SBF=1 SBF_OUT_DIR="$PWD/target/deploy" cargo test --locked -- --test-threads=1
```

The runtime tests use the actual vault and SPL Token processors with deterministic DBC/DAMM
fixtures. They exercise custody CPIs, successful burns, retained pre-existing balances, budget
isolation, replay/authority/deadline/output guards and funded claims. They are not a full Meteora
AMM or graduation rehearsal. The initialization takeover and Merkle-domain checks also have direct
tests. The compiled ELF harness loads the actual upgradeable-loader Program and ProgramData, checks
a successful governor bootstrap, and rejects an initialization takeover. Native and compiled-ELF
execution both passed all six tests in the isolated Linux environment, including the DAMM
claim-all/excess-allocation and immutable receipt test.

The SBF toolchain is pinned to platform-tools v1.53 (Rust 1.89 / LLVM 20), whose published archive
SHA-256 is `876b5c294a38d41d40bed4592911091e92cc3f399dd17a0f9cac87b1df9ab120`. The default older
platform toolchain cannot parse the pinned dependency graph's edition-2024 manifests. Keep
`Cargo.lock` and run both native and compiled-ELF tests after program changes.
`.github/workflows/vault.yml` performs these checks with pinned native Rust and checksum-verified
Agave/platform-tools archives. Generated deployment keypairs are not uploaded or committed.

Before releasing financial mainnet operations, run the built artifact through local/devnet
end-to-end flows using the real DBC/DAMM programs, review every signer role and economic invariant,
and verify production custody and signing. The owner declined an outside program audit on 28 October
2026; see [the decision record](../../docs/MAINNET-OWNER-DECISIONS.md). No independent audit is
claimed. A successful compile is not evidence of production custody or acceptance.
