> Historical reference: new plzzz.bond launches follow
> [the current Bond it. deployment guide](LIVE-DEPLOYMENT.md). Earlier fee schedules, mode choices
> and native-vault instructions below do not configure new bond-v1 launches.

# Build status — 28 October 2026

All work in this build is local. Heroku releases, production configuration and production databases
remain unchanged. The public site remains a whitelist campaign; the launchpad still requires admin
access, and mainnet financial execution remains closed in code.

The subsequent [owner decisions](MAINNET-OWNER-DECISIONS.md) approve settlement from actual received
position income, decline an outside audit and assign all authority/operational roles to the owner.
The supplied Helius endpoint passed live read-only mainnet checks. The owner supplied production
authority addresses, which passed address checks; both were unfunded at the finalized read. Signing
custody, operator hosting and funded acceptance remain incomplete. The recorded Linux artifact below
predates the latest readiness-report and rules-copy update; it is preserved evidence, not a new
deployment.

## Implemented

| Area             | Result                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launch policy    | Reviewed immutable config and original deployer/mode registry; native config approval; atomic pool creation and registration; saved launch receipts and recovery.                                 |
| Fees and custody | Native Solana vault, finalized event journal, complete-history checkpoints, one-time funding receipts and cumulative integer accounting. No deployment/operator key in the browser or web server. |
| Buybacks         | Bounded, expiring quotes; atomic purchase and burn of exactly the received tokens; durable jobs and finalized burn feed. Current supply is read after burns.                                      |
| Creator Fees     | Original creator recipient enforced by the native program; funded claims, available/paid balances and linked receipts.                                                                            |
| Community        | Complete same-bank owner snapshots, funded immutable Merkle epochs, canonical claim markers, paid receipts and cost estimates.                                                                    |
| Graduation       | Actual DBC-to-DAMM migration, permanently locked position binding, quotes/trades/history on the migrated pool, and saved migration receipt recovery.                                              |
| Web security     | Per-document script nonces, admin session revocation, strict relays, durable upload replay/cost limits, recoverable upload tags and bounded shared artwork caching.                               |
| Operations       | Bounded unsigned scheduler, durable recovery, portable operator bundles, read-only web/SQL/financial monitors, production preflight, tested local rollback and native/compiled-program CI.        |

RINSE starts at 90% and reduces every three seconds toward the nominal 1.25% fee over at most 27
seconds. The actual integer DBC schedule ends at 1.2505439%; its smooth decimal approximation is
1.2505439768%. Exact 1.25% is reached after graduation to DAMM. The current exponential DBC schedule
cannot reach exactly 1.25% while keeping its 90% start, nine periods and three-second step;
[the config reference](CONFIG-AND-GRADUATION.md#graduation-and-fee-floor-semantics) records this
calculation. The owner accepted this rounding on 28 October and approved public marketing as 1.25%;
it is no longer a release blocker. Permissionless graduation reaches DAMM's final fee earlier if the
curve fills first; post-graduation fees follow the selected mode. Buyback execution conservatively
waits until the scheduled window has elapsed. The optional bundled first buy uses the configured
minimum fee. The app caps its bundled purchase, not all later wallet ownership.

Hourly Community allocations use the complete finalized bank observed in the first minute after a
UTC hour boundary and label the just-closed hour. A missed window rolls funds forward. The actual
snapshot time/slot is recorded; the system does not invent historical balances. Small claims may
cost more than the reward because the claimant funds a permanent replay-protection account and pays
the network fee. Those costs are displayed before signing.

## Verification evidence

- All 305 app tests in 80 files and 76 operational/configuration/runtime tests pass. Repository-wide
  strict TypeScript reports no errors. Workspace lint passes with existing legacy warnings;
  formatting, 153 dependency version alignments and skill/config-template checks pass.
- A fresh isolated production build passes compilation, page generation and tracing. Its HTTPS
  browser checks pass document nonce rotation, hydration, wallet connection, blocked parser-inserted
  scripts and a 390px layout, with no browser errors. The Linux standalone artifact also passes
  build and HTTP/security smoke checks with the original source dependencies hidden. Its compiled
  APIs load offline, native image processing works, and the checked secret/fixture inventory is
  clean. The archive hash is recorded in [the security evidence](SECURITY-IMPLEMENTATION.md).
- Native Rust tests and the actual compiled SBF program each passed six runtime tests under the
  upgradeable loader.
- The current RustSec scan retains all 40 advisory/warning entries. Independent locked SBF graph
  comparisons find no reported runtime vulnerability or unsoundness; the runtime bincode maintenance
  warning remains. Native test tooling still has 14 vulnerability and 15 unsoundness entries. The CI
  guard rejects missing findings, stale evidence or runtime scope changes rather than hiding them.
  See [the Rust review](RUST-DEPENDENCY-REVIEW.md).
- Real Meteora DBC, DAMM and metadata program binaries run in an isolated validator. Both launch
  modes, high-tax trades, floor trades, fee collection, atomic buyback/burn, original-creator payout
  and an actual hourly Community payout have executed there.
- The separate mainnet-binary profile passes both atomic launch modes, RINSE/floor trades,
  graduation, real DAMM swaps, unsigned operator planning and native position binding. Both modes
  have finalized DBC/DAMM collections and authenticated SQL replay checkpoints. A fresh process
  restores those checkpoints and independently retrieves their archived event assignments. Actual
  outside LP addition/removal, a diluted trade, a restored-liquidity trade and the resulting
  incremental claim all pass. A second checkpoint links to its predecessor and preserves verified
  access to the first claim's frozen assignments. Both modes have verified atomic burns. Both modes
  also pass actual DAMM buys and sells with exact integer quote-to-execution output, fee and
  account-balance comparisons on the retained mainnet-binary ledger. The retained devnet-binary
  profile also passes actual DAMM buys/sells and exact comparisons in both modes, closing the
  original plan's explicit devnet requirement without resetting history.
- Browser checks passed image upload/display, saved launch recovery, claim submission response loss,
  paid receipt display, nested wallet connection and disabling a trade after quote refresh failure.
  Actual swaps and graduation recovered after injected lost relay responses, with only one
  preparation and submission. A slow signed Community claim was renewed after positive finalized
  expiry and unclaimed-marker proof, then paid once after a new wallet signature.
- A fresh mainnet-binary Community launch also recovered after the relay actually broadcast but its
  successful reply was replaced with an HTTP 503. The public receipt existed before the browser
  invoked fetch. Reload recovered the same finalized launch and image with exactly one wallet
  transaction signature, metadata authorization, relay request, chain creation and registry row. The
  isolated browser reported no page errors. Unit checks additionally cover failed browser storage,
  changed messages, missing signatures, stale expiry evidence and scoped receipt recovery.
- A production build passed browser nonce rotation, hydration, wallet connection, mobile layout and
  rejection of a parser-inserted script without the document nonce. Wallet signing in these UI
  checks uses isolated fixtures; physical mobile-wallet checks remain separate.
- The mainnet-binary browser profile also passes the actual Creator claim with a lost response, one
  preparation/submission and reload recovery. Both graduated token screens, real migrated-pool
  quotes and private finalized burn receipts render without browser errors.
- Legacy or unverified token configs show quote-dependent fees rather than the new schedule.
  Saved-transaction recovery forces a fresh genesis check before declaring expiry.
- API failure logs use fixed context messages; raw provider errors cannot expose RPC credentials or
  upstream response bodies through those logs.
- Signed upload replay and shared wallet/global budgets survive web restarts. Actual concurrent TLS
  SQL tests and an HTTP prepare/restart/replay check pass without signing or broadcasting a launch.
  Migrations also apply when whitelist registration is off; missing required storage fails closed.
- A bounded shared artwork cache coordinates downloads with crash-expiring leases and serves stale
  images during background refresh. Actual TLS SQL and fresh-process tests prove one download and
  persisted image reuse. Trade display now preserves multiple swaps and their real owner rather than
  assuming the transaction fee payer is the trader; incomplete decoding remains partial.
- A certificate-verified TLS Postgres restore matched all 34 tables, 185 constraints, 63 indexes, 17
  application triggers and three functions. It includes executed financial jobs, funding receipts
  and three independently authenticated restored checkpoints. Production was not altered.
- The genuine mainnet-binary unsigned scheduler tick processed two coins with no failures,
  signatures or sends. Fourteen operator plans and three financial jobs are finalized; two new
  unsigned setup plans remain prepared and preserved. Its immediate financial-health sample had no
  alerts or native cash shortfalls. After the later browser launch, indexing cleared the genuinely
  observed missing-cursor warning. That latest sample has no critical alerts or native shortfalls,
  but retains one warning covering two stale unsigned plans and four older paused-index warnings.
  These are point-in-time samples, not a claim that the rehearsal is a running production service.
- The scheduler passed real TLS cross-process exclusion and crash/restart recovery. Portable
  operator/scheduler bundles pass outside-checkout dry runs with global module search disabled. Both
  Windows and Linux smoke tests made only genesis reads and created no signature or send.
- The read-only full rehearsal preflight passed 26/26 checks with independently pinned code,
  authorities/config, native approval, schema and a genuine fresh planner heartbeat. It still
  reports financial release not ready; public pins do not establish production custody or audit.
- Current to older test-only to current standalone rollback passed on the same local port against a
  new restored database with unchanged full data/schema inventories. The latest candidate also
  passed live anonymous web and TLS database monitoring. The old test build is not an approved
  production fallback. See [operations verification](OPERATIONS-VERIFICATION.md).

One early validator run pruned old history during the hour-boundary test. The financial indexer
correctly refused to declare that history complete. Its evidence is retained separately; fresh coins
repeat the full index-to-graduation path with an explicitly enlarged retention capacity. No missing
interval is treated as a completed scan. See [the rehearsal reference](LOCAL-PROTOCOL-REHEARSAL.md).

## Requirements before real funds

The read-only public binary comparison found different DBC, DAMM and metadata binaries on mainnet
versus devnet. The separate mainnet-binary rehearsal uses a different local genesis, vault and
isolated signer profile, with its own evidence. Neither profile sends a transaction to mainnet.

Stock DAMM permits other people to add liquidity while trading is enabled. That dilutes the fraction
of pool fees earned by the program's original permanent position. Position-fee accounting separates
outside LP earnings from integer rounding and supports outside additions/removals. It also means the
original fixed destination shares of **every pool trade** cannot be guaranteed by owning the initial
LP alone. The owner approved allocating actual received position income instead on 28 October. See
the protocol's
[permissionless pool access rules](https://github.com/MeteoraAg/cp-amm/blob/main/programs/cp-amm/src/pool_action_access/permissionless.rs).
The inspected SDK/mainnet contract has no setting that prevents outside liquidity while leaving
public swaps open.
[The contract decision](DAMM-FEE-REALIZATION.md#release-decision-for-fixed-destinations) describes
the approved income-based option and the new integration that fixed shares of all trades would
require. The fee-basis decision is no longer a release blocker.

1. The owner declined an outside financial-program audit; no independent audit is claimed. The
   operator remains a trusted attestor of historical fee phases and holder roots; Merkle proofs do
   not remove that trust. Internal checks, actual signing permissions and custody verification
   remain necessary. Program and external protocol upgrade authorities remain trust points.
2. Set up and independently verify production governor, operator, treasury, upgrade authority,
   program/config approval and archival RPC. Local fixture addresses and fake SOL are not production
   credentials or funding.
3. Accept the complete retained-history DAMM fee/surplus rehearsal and final release checks. A
   native unit test, a local protocol clone and a public-network deployment prove different things.
4. The owner is responsible for scheduler/signing operations, monitoring response and
   backup/restore. Configure the actual operator host, production signer and alert delivery. Verify
   production backup/rollback and physical iOS/Android wallet flows.
5. Prepare an explicit reviewed release that opens the financial gate. Setting an environment flag
   alone cannot open this version. No Heroku deployment is part of this build request.

The planned $RINSED airdrop is separate from token trading rewards. Referral counts are recorded,
and the site explains that referrals increase an allocation without publishing numbers. Token
funding, eligibility approval and airdrop distribution have not been invented by this build.

Operator references: [financial operations](FINANCIAL-OPERATIONS.md),
[web controls](WEB-SECURITY.md), [restore and monitoring](OPERATIONS-VERIFICATION.md),
[dependency treatment](SECURITY-IMPLEMENTATION.md).
