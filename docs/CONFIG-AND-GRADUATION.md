> Historical reference: new plzzz.bond launches follow
> [the current Bond it. deployment guide](LIVE-DEPLOYMENT.md). Earlier fee schedules, mode choices
> and native-vault instructions below do not configure new bond-v1 launches.

# Configuration, registration and graduation implementation

These changes are local. No hosting deployment, database mutation against Heroku or financial
network transaction was performed by this implementation.

## Configuration and immutable identity

Migration `003-launch-registry.sql` introduces chain-scoped configuration, signed launch intent,
coin identity, migration mapping and migration history-proof records. Financial identities cannot be
reassigned by ordinary UPDATE/DELETE. The only mutable configuration field is the admission switch;
disabling preparation does not erase existing coins. The registry is a recovery/indexing layer, not
a replacement for native custody enforcement.

New explicit Creator Fees/Community launches require an independently reviewed configuration, the
exact configuration data hash, the configured native program's fee-authority PDA, a matching
on-chain config approval, an executable native program and unpaused native settings. The new
template has no extra creation/migration charge, no dynamic fees and all permanent LP fee rights
under the program authority. Old configs remain discoverable through `LEGACY_POOL_CONFIG_KEYS` and
registry records, with each pool's own config and actual mint supply/decimals.

The signed wallet message includes the explicit readable mode and commits to it in the payload hash.
A durable intent is recorded before upload work. The unsigned creation transaction appends native
custody registration atomically. `/api/launch/confirm` verifies a successful finalized creation,
original creator/mint signatures, exact custody instruction accounts/mode and actual finalized
custody identity before inserting the immutable registry record. A changed creator field or metadata
cannot redirect the original creator's rights. Retry confirmation rather than creating another token
if the wallet transaction already landed.

New intents pin the finalized preparation slot. Confirmation rejects creation before that slot; it
remains recoverable after intent expiry or when Solana's clock lags the operator's wall clock. The
signed authorization expiry controls preparation, while the exact atomic native identity proof
controls confirmation. Old zero-slot intents cannot prepare reviewed launches.

Actual installed SDK packet measurements, with the maximum UTF-8 token name/ticker lengths and a
92-byte metadata URI: creation plus native registration is 977 bytes; the atomic optional first-buy
variant is 1,197 bytes; migration with both ephemeral position-mint signatures is 1,139 bytes. The
packet limit is 1,232 bytes. Preparation checks the actual unsigned packet, including every required
signature; oversized custom metadata URLs fail before wallet signing. The first buy is never split
out of the creation transaction.

Market-cap candles normalize all observed prices to the current verified mint supply, including the
initial launch candle. They do not reconstruct supply at historical blocks; the chart labels that
limit. Graduated history merges original DBC and canonical DAMM events and retains partial history
flags. Browser RINSE countdowns synchronize to RPC chain time and use a monotonic elapsed clock
between updates; demo fixtures retain their independent browser-time clock.

`GET /api/launch/status?mode=creator` reports actual configured creation costs and readiness.
`node scripts/register-launch-config.mjs` is read-only by default. Private environment must contain
the intended network/RPC/config, matching vault program IDs and independently supplied
`EXPECTED_FEE_CLAIMER` / `EXPECTED_LEFTOVER_RECEIVER`. `--write` persists the reviewed record;
`--write --enable` also enables preparation after verifying native settings are unpaused. It never
creates an on-chain config, deploys a program, unpauses custody or opens mainnet trading.

## Local validator

The rehearsal pathway requires all of:

- `NEXT_PUBLIC_NETWORK=localnet` and `LOCAL_VALIDATOR_ENABLED=true`.
- A nonproduction process, loopback RPC and loopback canonical site/aliases.
- An independently pinned `LOCAL_VALIDATOR_GENESIS_HASH` matching the actual node; known devnet and
  mainnet genesis values are rejected as local pins.
- Matching `NEXT_PUBLIC_LOCAL_VALIDATOR_RPC_URL`, if provided, and no URL credentials.

Production rejects local configuration. Mainnet trading remains fail-closed. The shared helper is
`scripts/network-policy.cjs`; `launchConfig.verifiedGenesis(connection)` and the transaction gate
use it. `audit-launch-config.mjs --localnet` checks the pinned local network. Wallet adapter
metadata uses its supported devnet signing context, while app labels/explorer links identify the
local validator explicitly. Existing devnet behavior remains supported.

The SDK rehearsal accepts guarded `--fixture-file` and `--state-file` paths. The separate
mainnet-binary local profile uses `.local/mainnet-binary-fixture.json` and
`.local/meteora-mainnet-binary-state.json`; it never copies an earlier devnet-binary config or coin.
Both profiles use fake balances and VM-only funded signers. Public mainnet protocol binaries differ
from devnet binaries, so a devnet-binary rehearsal is not evidence of mainnet-binary compatibility.
`--graduate-unbound` deliberately omits native migration binding, allowing the real operator planner
to prove its unsigned binding, signature relay and finalized verification path. `--graduate` retains
the convenience binding for isolated SDK diagnostics.

## Graduation and fee-floor semantics

The reviewed exponential DBC config targets a nominal 1.25% endpoint, but its integer reduction
parameter cannot represent that endpoint exactly while preserving the exact 90% start, nine periods
and three seconds per period. The SDK derives reduction factor 3782 basis points. Its actual Q64
integer calculation ends at fee numerator `12,505,439` over `1,000,000,000`, or **1.2505439%**. The
smooth decimal approximation is about 1.2505439768%; quotes must use the integer protocol
calculation. Adjacent factor 3783 yields 1.248735%, below the requested endpoint. Exhaustive
evaluation of all valid integer reduction factors finds no exact 12,500,000 numerator for this
schedule. The protocol has no separate configurable exact-terminal clamp. See the primary
[on-chain scheduler](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/main/programs/dynamic-bonding-curve/src/base_fee/fee_scheduler.rs)
and
[SDK implementation](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/blob/main/packages/dynamic-bonding-curve/src/math/poolFees/feeScheduler.ts).

After graduation, the reviewed static DAMM fee numerator is exactly 12,500,000 (1.25%). On 28
October 2026 the owner accepted the existing rounded DBC endpoint and instructed that public
marketing keep the 1.25% label. Preserve the reviewed schedule and actual integer quote/execution
calculations. Rounding is no longer an outstanding product decision. Mainnet stays closed for the
separate fee-routing, production custody and security acceptance requirements.

Quotes/swaps switch to the deterministic canonical DAMM v2 migration PDA, verify program owner and
mint pair, use real SDK quote math and keep the actual fee token unit. Legacy output-token fees are
not presented as exact SOL fees. Actual mint supply drives market cap, including after burns. The
relay only accepts known launch/trade/migration routes and canonical native user claims; unrelated
transfers cannot be smuggled in beside an allowed program instruction.

`POST /api/launch/migrate` returns wallet-signable migration transactions. Its ephemeral NFT mint
signatures are already attached; no existing deployment or treasury key enters the web process. Send
transactions in order. Submit the final migration signature to `POST /api/launch/confirm-migration`;
finalized confirmation records the actual creation boundary.

Stock DBC can graduate as soon as its reserve threshold is reached. Its DAMM v2 creation does not
preserve the original time scheduler. RINSE therefore ends at the earlier of the scheduled floor or
graduation to the flat fee floor. The financial indexer classifies verified DAMM events as
post-RINSE. Native buybacks conservatively wait through the original 27-second boundary.
`launch_migrations.migration_activation_point` comes from actual finalized CPAMM timestamp
activation. A discovery slot is never used as a history boundary: `launch_migration_proofs` needs
the verified migration transaction signature and slot. Missing/bounded-out history remains
incomplete and cannot be attested as a full fee backlog.

## Why a permanent Token-2022 hook was not substituted

Official
[DBC migration source](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/main/programs/dynamic-bonding-curve/src/instructions/migration/dynamic_amm_v2/migrate_damm_v2_initialize_pool.rs)
checks curve completion and creates the customizable DAMM pool with `activation_point: None`.
[DBC configuration source](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/main/programs/dynamic-bonding-curve/src/state/config.rs)
explicitly implements fixed migrated time fees; nonzero remaining time-scheduler parameters are not
carried across graduation.

[DAMM token transfer helpers](https://github.com/MeteoraAg/damm-v2/blob/main/programs/cp-amm/src/utils/token.rs)
do not forward transfer-hook extra accounts in the checked transfer CPI. The installed SDK also has
no swap hook-account parameter. A permanently hooked token would therefore not become normally
tradable merely because 27 seconds elapsed. Additionally,
[DBC token initialization](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/main/programs/dynamic-bonding-curve/src/utils/token.rs)
sets the hook update authority to the DBC pool-authority PDA, and the installed DBC interface has no
hook deactivation instruction. Silently substituting this policy would risk trapped tokens. An
unconditional 27-second tax across every venue needs upstream support or a different protocol; the
current product instead discloses the actual fee-floor/early-graduation behavior.

## Verification

Unit tests exercise real CPAMM account layout decoding and quote math, deterministic migration
addresses, fee units, wrong owners/pairs, exact atomic registration proof, signed mode admission,
LP/fee bypass rejection, relay transfer smuggling, claim recipient substitution and strict local
network overrides. These tests do not substitute for executing the full native/DEX lifecycle on an
isolated validator with the actual deployed program binaries.
