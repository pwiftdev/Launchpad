# Isolated protocol rehearsal

This rehearsal writes only to an isolated validator at `http://127.0.0.1:8899`. The application and
signing helpers reject production mode, known public cluster genesis hashes, and a genesis that
differs from the independently pinned local fixture. No hosting configuration or public-network
transaction is part of this workflow.

## Protocol artifacts

Separate real program snapshots were downloaded through read-only public devnet and mainnet RPC. The
first profile used the following devnet artifacts:

| Artifact | Program                                       | SHA-256                                                            |
| -------- | --------------------------------------------- | ------------------------------------------------------------------ |
| DBC      | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | `5edf76d972abaf355048db5d9003bc4dfa843cd98a5f93785430dac371678ad3` |
| DAMM v2  | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | `82bb9375921bb8007551cb65f9ca43b191597496cc9922926468b36671081ec2` |
| Metaplex | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` | `bb0842f6d5740eabe8f9fb3b723b9ecd89cadf9f48ef9ad6a9dc6cfa8a9658e4` |

The mainnet snapshot differs for all three programs, including their actual ELF bytes after removing
allocation padding. The separate `mainnet-binaries` profile uses these exact dumps:

| Artifact | Mainnet dump SHA-256                                               | Last upgrade slot |
| -------- | ------------------------------------------------------------------ | ----------------- |
| DBC      | `e2bfc853c1a1778dd8ee40ea9a0f3edf5587442360c57c685e7e3024ad0cad47` | 457502600         |
| DAMM v2  | `967ff9fb161eec2e62f66d2c899100739fb747c445f697b8625c86b31b9a2022` | 457080014         |
| Metaplex | `31f0a627dba051a938de650464e55cc5397a4be0fd496929c1f9cf02fe5e9011` | 380725176         |

The finalized comparison, active-ELF hashes, public authorities and read slots are recorded in
`.local/mainnet-program-comparison.json`. Metaplex's mainnet upgrade authority was revoked in this
snapshot. Re-run comparison before promotion: a devnet result alone does not prove compatibility
with a different mainnet program version.

The mainnet-binary LOCAL genesis is `GxBSPRteo4BvjKLkKC3AYeK2EVnCtsTpFa2W4qxr4J6H`, with local vault
`H1MYH8Uku7Y3Qhp997KfC3TRM4fVW7uvube69ioWqFa6`. Its public fixture/state are
`.local/mainnet-binary-fixture.json` and `.local/meteora-mainnet-binary-state.json`. Both launch
modes, RINSE/floor trading, fee collection, canonical graduation/binding, DAMM trades, actual
buyback/burn, outside-LP accounting and authenticated checkpoint restore/archive flows passed there.
Native hourly claims were separately exercised against the same vault ELF in the first local
profile. This is local execution of mainnet bytecode, not transactions on the real mainnet.

The canonical custom migration configuration `A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck` is also
copied as public account data. Downloading these accounts does not sign a transaction. Later
upstream upgrades require new artifact hashes and another rehearsal.

The public DBC global pool authority also needs its rent reserve. In the real rehearsal the omitted
local account caused CPAMM creation to fail despite a funded migration caller; the
[upstream flash-rent implementation](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/main/programs/dynamic-bonding-curve/src/instructions/migration/flash_rent.rs)
reimburses the lender only after creation. A separately recorded local operator transfer
bootstrapped the recommended one-SOL reserve. It is protocol setup and is never credited to a vault
fee budget. The bootstrap script now checks this account before migration work.

## Keys and transaction boundary

`scripts/local-validator-bootstrap.sh` runs inside the isolated Linux VM and accepts only
`devnet-binaries` or `mainnet-binaries`. Each profile has separate ephemeral funded role keys,
ledger and genesis under `/root/rinsed-rehearsal` or `/root/rinsed-rehearsal-mainnet`. It deploys
the built vault locally with its actual governor upgrade authority, and emits a public fixture. Keys
remain in that VM. Copy only the public fixture to the host and select it explicitly for each
profile.

Install `scripts/local-vm-signer.cjs` as `/root/rinsed-rehearsal/local-signer.cjs` alongside the
isolated Node/web3 installation. The host `scripts/local-vm-sender.cjs` builds transactions and
passes their public serialized messages over authenticated SSH. It loads no funded role key.
Ephemeral mint, configuration and position NFT keys can sign in host memory and are never saved.

The VM repeats the fixed-loopback and genesis checks before reading a role key. Its `sign-only`
action returns signed bytes and a signature without broadcasting. Financial workers must persist
those bytes and their submitted state before relaying them; the setup SDK script can use `send`. The
web server must not receive these key files or invoke an unrestricted production signer. For the
isolated browser rehearsal, `signMessage` accepts only the existing reward authorization format
bound to `http://127.0.0.1:3003`, the pinned local genesis and the selected wallet. It returns an
Ed25519 signature without transferring funds; arbitrary or public-site messages are rejected.

## SDK phases and evidence

Set explicit development-only local-validator settings and independently pin
`LOCAL_VALIDATOR_GENESIS_HASH` to the local validator's public genesis. The required environment is
validated by `scripts/network-policy.cjs`; the rehearsal does not infer approval from a URL.

Run `scripts/local-meteora-rehearsal.cjs` with `--prepare`, then `--post` after the actual chain
clock reaches the RINSE boundary, and `--graduate` for real migration and a DAMM trade. The script
uses the checked-in reviewed curve template and vault ABI, validates canonical on-chain state, and
records public identities, signatures and slots incrementally in
`.local/meteora-rehearsal-state.json`.

After graduation, run `--damm-roundtrip` with the same explicit `--fixture-file` and `--state-file`.
This performs a real DAMM buy and sell for each mode. It saves the integer quote, pool snapshot
hash, and signed message before relay, then checks the finalized canonical `EvtSwap2` amounts and
fee components against that quote. Trader base-token and native-SOL deltas must also match,
including the separately recorded network fee. A rerun recovers an already saved signature rather
than creating another trade after a lost response. The comparison requires an existing base ATA and
absent WSOL ATA so wrapping rent nets to zero.

The retained mainnet-binary ledger passed all four comparisons with zero input, output and fee
differences. Amounts below are raw integers, without display rounding:

| Mode      | Side | Finalized slot | Input        | Quoted and executed output | Quoted and executed total fee |
| --------- | ---- | -------------- | ------------ | -------------------------- | ----------------------------- |
| Creator   | Buy  | 3930           | 200000000    | 485340155191               | 2500000                       |
| Creator   | Sell | 3964           | 242670077595 | 97635205                   | 1235889                       |
| Community | Buy  | 3997           | 200000000    | 490105665756               | 2500000                       |
| Community | Sell | 4031           | 245052832878 | 97635790                   | 1235897                       |

The public signatures, exact prepared quotes and independently decoded account/event witnesses are
in each coin's `dammComparisons` in `.local/meteora-mainnet-binary-state.json`, with a compact copy
in `.local/damm-roundtrip-result.json`. The original genesis, roles, programs and history were
retained; this continuation did not reset, redeploy, airdrop or change a fee configuration.
`node --test scripts/local-damm-comparison.test.cjs scripts/local-meteora-rehearsal.test.cjs` also
checks integer comparisons and rejects fee, quote, account-delta and minimum-output mismatches.

The same reusable phase also ran against the retained **devnet-binary** fresh-coin ledger, without
changing its `DYsbLu191gfQdVsnnTjrAtEYBMFm23XhyLRHaSgt6G3n` genesis, roles or programs. Both modes
passed actual buys and sells with zero quote differences and matching wallet deltas. Evidence is
`.local/damm-devnet-roundtrip-result.json` and each coin's `dammComparisons` in
`.local/meteora-rehearsal-state-fresh.json`; the earlier pruned negative fixtures remain intact.

| Mode      | Side | Finalized slot | Input        | Quoted and executed output | Quoted and executed total fee |
| --------- | ---- | -------------- | ------------ | -------------------------- | ----------------------------- |
| Creator   | Buy  | 14635          | 200000000    | 482968178491               | 2500000                       |
| Creator   | Sell | 14669          | 241484089245 | 97634912                   | 1235885                       |
| Community | Buy  | 14702          | 200000000    | 490105665756               | 2500000                       |
| Community | Sell | 14735          | 245052832878 | 97635790                   | 1235897                       |

The durable fee, buyback and reward workers must additionally demonstrate actual DEX fee claims,
funding receipt reconciliation, purchased-token-only burns, fixed-recipient claims, funded Community
epochs, claim replay rejection, and restart recovery. Import launch and financial records into the
isolated database only after validating their finalized chain receipts.

An early local run used an undersized ledger cap and lost RPC history while waiting for the hour
boundary. The indexer correctly rejected its missing cursor anchor. Omitting that option also proved
insufficient: Agave defaults to only 10,000 shreds. The checked-in bootstrap now sets an explicit
10,000,000-shred capacity. Its retained block floor was checked while slots advanced, and a separate
`.local/meteora-rehearsal-state-fresh.json` repeats the full coin history without discarding the
original claim evidence. Monitor disk capacity and cursor-anchor availability; a configured cap
alone does not prove archival continuity.

`node --test scripts/local-rehearsal-safety.test.cjs` checks the host boundary without network or
signer keys. Native processor and compiled-ELF vault tests are separate checks; their DEX fixtures
do not count as a successful real-protocol rehearsal.

The finalized event and holder snapshot operator remains a trusted attestor. The program upgrade
authority and external Meteora upgrades also remain explicit trust boundaries. Mainnet financial
operations stay closed until production setup and funded acceptance are complete. The owner
subsequently declined an outside audit and approved received-income settlement; see
[the owner decisions](MAINNET-OWNER-DECISIONS.md). No independent audit is claimed.
