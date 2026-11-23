> Historical reference: new plzzz.bond launches follow
> [the current Bond it. deployment guide](LIVE-DEPLOYMENT.md). Earlier fee schedules, mode choices
> and native-vault instructions below do not configure new bond-v1 launches.

# Launch plan — 28 October 2026

**Build locally and keep Heroku unchanged until mainnet testing is ready.** This is the owner's
current instruction. The implemented financial system, actual test evidence and remaining release
requirements are tracked in [the current build status](BUILD-STATUS-2026-10-28.md). Keep financial
mainnet closed until production custody, signing and acceptance evidence exists. The
[owner decisions](MAINNET-OWNER-DECISIONS.md) approve actual received fee income, decline an outside
audit and assign authority and operations to the owner. Outside-audit approval is no longer pending;
internal verification and the financial safety checks remain in force.

The current audit is [PROJECT-AUDIT-2026-10-27.md](PROJECT-AUDIT-2026-10-27.md). Dates and
checkpoints use Europe/Ljubljana time.

## Promotion work from the previous release (historical)

1. The shared 90% policy and corrected copy were released with the whitelist-only public gate.
2. Verify live desktop/mobile registration, wallet cancellation/signature/receipt recovery, referral
   attribution and operator totals. Remove only exact synthetic test records.
3. Confirm HTTPS on both approved origins, guest/private separation, logout, database TLS, backup
   schedule and the previous release available for rollback.
4. Save the audit evidence privately; make an owner-reviewed source checkpoint before the next
   financial implementation. Existing work is uncommitted and must not be discarded.

## Build order and acceptance requirements

The work below is now implemented in local source. Follow the current build status for which
acceptance checks have completed; do not read this original ordering as a deployment instruction.

| Order | Deliverable                       | Acceptance evidence                                                                                                                                                                                                                                                                                   |
| ----- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Verified config and coin registry | Immutable config IDs and original deployer/mode/recipient records; actual genesis/account-owner checks; 90% schedule; reviewed rounding, dynamic-fee disablement, supply/authority and LP settings; legacy configs remain discoverable. Enforce the policy in release/startup and launch preparation. |
| 2     | Custody and durable fee journal   | Reviewed vault/program authority design; no browser/server deployment private key; finalized fee events recorded once by transaction and instruction/event identity; integer conservation, checkpoints, reorg and retry recovery.                                                                     |
| 3     | RINSE buyback/burn worker         | Jobs become eligible after RINSE; funded budget; bounded size, age and slippage; crash/retry tests prove no duplicate spending; actual received token amounts burned; finalized trade/burn links; live supply and market cap reflect burns.                                                           |
| 4     | Creator Fees settlement           | Mode/recipient cannot be reassigned through metadata or creator transfer; funded accrual and claims, controlled withdrawal rights, no double payment and visible available/paid balances.                                                                                                             |
| 5     | Community rewards                 | Complete finalized owner snapshots at hourly boundaries; documented exclusions and dust rollover; funded SOL claim vault; deterministic allocations; double-claim and failure/retry tests; no top-20 approximation.                                                                                   |
| 6     | Graduation and trading continuity | Full devnet launch→buys/sells→migration→DAMM v2 buys/sells rehearsal; correct fees, LP locks and recipient rights after graduation; compare quotes with executed amounts.                                                                                                                             |
| 7     | Release/security operations       | Close dependency/runtime findings, required CI green, signer custody and rotation review, bounded RPC/image jobs, monitoring/alerts, isolated backup restore and rollback drill.                                                                                                                      |

Configuration verification is now available:

```sh
# Offline: no wallet, RPC, settings change or transaction
node scripts/audit-launch-config.mjs --template

# On-chain: RPC_URL and POOL_CONFIG_KEY come from the operator's private environment.
# Supply reviewed public authority addresses independently:
# EXPECTED_FEE_CLAIMER and EXPECTED_LEFTOVER_RECEIVER.
node scripts/audit-launch-config.mjs --devnet

# With no argument the checker requires actual mainnet genesis:
node scripts/audit-launch-config.mjs
```

The checker is read-only. The current legacy devnet config should fail the new economic policy
because dynamic fees and migration settings differ. An offline template pass does not prove
recipient ownership, LP safety, funded claims or mainnet readiness. Mainnet checks must not use
observed addresses as their own expected values. The integer DBC endpoint is 1.2505439% (smooth SDK
approximation 1.2505439768%). The owner accepted that rounding on 28 October and approved marketing
the fee as 1.25%. Keep actual quote/execution math unchanged; this decision is no longer pending.

## Release acceptance checks

- [ ] Public root still opens the whitelist, and no public link grants launchpad access.
- [ ] A fresh signed-wallet referral flow succeeds on `rinsed.fun`; private operator counts agree.
- [ ] Existing receipts survive a deployment/restart; approved/revoked status behavior is checked.
- [ ] Mobile wallet deep links are checked on physical iOS/Android devices, beyond browser mocks.
- [ ] Backup schedule is confirmed; restore procedure and error/latency monitoring have an owner.
- [ ] Public copy makes no claim that buybacks, burns or airdrop claims have already executed.
- [ ] Mainnet signing and treasury custody are reviewed outside source code/chat.
- [ ] Every financial deliverable above has evidence, a reviewed implementation and passing tests.

If the financial checks remain incomplete, promote the whitelist and planned launchpad without
opening real-money operations. Announce a trading opening only after the acceptance evidence exists.
No financial safety check is waived by the calendar date.

## Historical release verification — 27 October

The site changes deployed successfully as Heroku release 25. Live browser checks verified 90% copy
on the whitelist, rules, launch and Testcoin screens at desktop and 390/320px widths, guest/private
access separation on both approved origins, private API access and logout. No browser errors
occurred. The final configuration-checker correction is included in the follow-up source release;
its exact build/release is recorded in private `.local/heroku-state.json`.

The signed-wallet/referral regression passed on `rinsed.fun`: wallet cancellation, registration,
secure receipt cookies, receipt reload, referral short links, failed optional inviter lookup,
duplicate-count accuracy, immutable attribution, self/unknown-referral rejection, signature
tampering, concurrent nonce replay, origin restrictions and operator CSV agreement. No financial
transactions were requested. Exact synthetic records were removed; database TLS 1.3 was verified and
the registration table was empty afterward.

The web app passed TypeScript, ESLint and 100 tests; 8 environment and 4 configuration-policy tests
passed. The offline SDK config check passes. The finalized devnet config correctly fails the new
policy on dynamic/graduation settings. Mainnet genesis was verified by a read-only RPC call. Root
strict TypeScript still reports 112 diagnostics. The configured backup schedule was read back as
daily at 02:00 Europe/Ljubljana. A restore drill remains outstanding.

## Work that can follow a verified financial release

More visual effects, richer watchlist tools and expanded social/token analytics are lower priority
than reliable execution, correct figures, account recovery and operating alerts. The $RINSED airdrop
distribution is its own funded release: decide eligibility and review referral farming before
building allocation/claim execution. No public amounts or formula are introduced by this plan.
