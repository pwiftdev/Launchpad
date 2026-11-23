# Project audit — 27 October 2026

**Whitelist promotion can continue. Mainnet token trading is not ready for release.** The starting
tax is 90%. The missing work is mostly financial execution and verification, not visual polish. The
release checklist and build order are in [LAUNCH-PLAN.md](LAUNCH-PLAN.md).

## Follow-up status: 28 October

Subsequent [owner decisions](MAINNET-OWNER-DECISIONS.md) approve actual received position income,
decline an outside audit and assign authority/operations to the owner. Earlier pending audit and
fee-choice entries below retain their historical context; current release requirements are in that
decision record and the build status. The supplied mainnet RPC passed live read-only capability
checks. The owner later supplied intended production addresses; signing custody, operator host and
funded acceptance remain outstanding.

The findings below retain their original 27 October evidence. They are not a description of the new
local implementation. The full current record is [the build status](BUILD-STATUS-2026-10-28.md). No
new source has been deployed to Heroku during this build.

| Finding | Current local evidence                                                                                                                                                                 | Remaining release requirement                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| F01     | Native vault, immutable config/mode/recipient registry, funded finalized fee journal and authenticated replay checkpoints; actual local protocol collections in both modes.            | Independent custody/program review and production authorities.                                                         |
| F02     | Durable jobs, bounded quotes, atomic purchased-token burn, crash/expiry/response-loss recovery and verified burn receipts; executed locally with actual protocol programs.             | Production keeper/signer ownership and independent review.                                                             |
| F03     | Funded creator claims and complete same-bank hourly Community epochs, owner aggregation, exclusions, claim markers and confirmed payouts.                                              | Physical-wallet checks; program/custodial claim wrappers are outside the direct-wallet path.                           |
| F04     | Verified immutable policy admission, native config approval and fresh genesis checks; separate devnet/mainnet-binary local profiles.                                                   | Production program/config/custody and fixed-all-pool fee routing choice; endpoint rounding accepted.                   |
| F05     | Canonical migration/binding, actual DAMM buys and sells in both modes, exact prepared-quote/event/account comparisons and indexed results.                                             | Approve the actual release artifact and current upstream program versions.                                             |
| F06     | UI states app moderation/first-buy limits accurately; native custody/registry enforces financial identities.                                                                           | App checks do not restrict permissionless purchases or additional LPs.                                                 |
| F07     | Patched/upgraded reachable dependencies; five registry findings remain documented with tested runtime treatment or optional-tool isolation. Linux artifact tests cover the used paths. | Independent review and upstream fixes for remaining advisories; no zero-vulnerability claim.                           |
| F08     | Durable upload signature consumption and shared wallet/global provider budgets; actual TLS SQL concurrency and HTTP restart/replay tests.                                              | General API/IP/concurrency limits remain process-local; configure production edge controls.                            |
| F09     | Display keeps actual swap owners, multiple swaps and compatibility deduplication; ambiguous/incomplete history stays partial. Financial accounting uses its separate complete journal. | Display histories/market stats remain bounded or sampled and never authorize payments.                                 |
| F10     | Actual supply/decimals, bounded trade caches, durable bounded artwork cache, cross-process leases, stale/background refresh and restart reuse.                                         | Dedicated production RPC and realistic production traffic/load checks.                                                 |
| F11     | Signed referrals, immutable attribution and private per-wallet/operator counts; planned airdrop copy contains no allocation numbers.                                                   | Farming review, eligibility snapshot, funding and separate airdrop distribution release.                               |
| F12     | Admin session epoch/cutoff revocation and private handlers; no deployment/operator signing key in the web process.                                                                     | Hosting MFA, incident ownership and production signer custody outside the shared web password.                         |
| F13     | Enforced per-document script nonces and production wallet/mobile browser tests, including blocked parser-inserted script.                                                              | Hosting edge/DDoS controls and physical-wallet checks.                                                                 |
| F14     | Root strict TypeScript, app tests, lint, formatting and dependency alignment pass; Linux standalone build/smoke evidence exists.                                                       | Owner-reviewed source checkpoint and hosted CI for that exact committed release; the working tree remains uncommitted. |
| F15     | Standalone artifact portability/private-file checks, financial monitoring and actual TLS database restore with data/schema/guard/checkpoint comparisons.                               | Production backup/rollback drill, HTTP/DB alerting and operator response ownership.                                    |

These closures distinguish local implementation/testing from production acceptance. Mainnet remains
closed; the completed local rehearsals are not an independent audit or a real-funds release.

## Scope and evidence

Reviewed the current working tree, launch/quote/swap/relay paths, wallet signatures, admin gate,
whitelist/referrals, database and migrations, remote images, fee accounting, trade decoding, holder
data, dependency graph, CI and Heroku deployment. Existing user changes were preserved. Read-only
hosting, database and finalized devnet reads checked the deployed state. No mainnet transactions,
new treasury keys or funded contracts were created.

This is a code and deployment review with regression tests. It is not an independent smart-contract
audit, adversarial penetration test, production traffic load test or proof of custody of the
configured wallets. Findings are potential failures with concrete code evidence; none is a claim
that an attacker has already exploited the app.

## Confirmed deployed state

- `rinsed.fun` has an issued certificate. Heroku runs one Basic web dyno on Heroku-24.
- Public visitors reach `/whitelist`; private pages redirect and private APIs return 401. The admin
  gate is configured. Mainnet trading remains disabled and checks the RPC genesis.
- Whitelist data uses Postgres Essential-0, certificate-verified TLS and transactional migrations.
  The inspection found zero registrations/referrals before synthetic regression checks.
- The actual RPC genesis is devnet. Config `53k7otaALZ9QwhciXv9Wm8SVP5tek3iVUrNjZ4DQB6Pj` has four
  pools. Their starting base fee is 90%, using nine exponential reductions every 3s.
- Those four mints each have one billion tokens, six decimals, no mint authority and no freeze
  authority. This does not by itself prove liquidity safety or honest trading.
- The current fee claimer and all four observed pool creators are
  `5iskTyXpKn7HeqvNUFBFc1rv2C2EoFNBNyFmXgGFztgS`. New launches use the signing user's wallet as
  payer/creator. The web server builds transactions; it does not hold a deployment signer.
- The old devnet config enables dynamic fees and uses migration fee option 2. Editing the repository
  template does not modify those existing on-chain accounts.

Private raw evidence is in `.local/project-state-2026-10-27.json` and
`.local/audit-2026-10-27.json`. Neither file is deployed or a public endpoint.

## Tax changes completed

- Replaced the remaining 70% claims in the rules and mainnet notes with 90%.
- Site fee copy now reads shared policy values: whitelist, launch form, board explanations, rules
  and token tax banner. Removed outdated promises of RINSE holder payouts, automatic deadline
  payouts and fully enforced fairness from the affected components/share text.
- The planned schedule remains 90% toward 1.25% over 27s, with reductions every 3s. The optional
  bundled creator first buy still uses the configured minimum-fee exception.
- The dry-run Studio template now disables dynamic fees and requests customizable 1.25% DAMM v2
  trading fees after graduation. The matching reference template was synchronized. The SDK curve
  builder successfully produces those settings. Nothing was created on-chain.
- `scripts/audit-launch-config.mjs` checks the offline template or a finalized on-chain config. It
  verifies the actual RPC network, account owner, fee schedule, supply, authority policy, migration
  settings and independently supplied expected fee/leftover recipients. Passing that check is not a
  financial release approval and does not open the trading gate.
- Added schedule, boundary, SDK rounding, template, configuration mismatch and fail-closed tests. CI
  runs the offline configuration check.

**Rounding:** the installed SDK derives a reduction factor of 3782 bps. Its nominal 1.25% endpoint
is approximately **1.2505439768%**, before per-trade integer rounding. Existing devnet coins can
additionally charge dynamic fees. Copy now distinguishes the target/base schedule from the live
quote. Exact mainnet endpoint acceptance remains a configuration release decision; do not describe a
rounded target as an exact executed charge.

## Findings requiring work

| ID  | Priority                   | Evidence and consequence                                                                                                                                                                                                                         | Required completion                                                                                                                                                                                                        |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 | Trading blocker            | `server/economics/feeLedger.ts` is an in-memory integer allocation function. No funded custody contract/vault, durable fee journal, mode registry or executor calls it. Advertised economics cannot currently be enforced.                       | Persist immutable per-coin policy/recipient records; implement reviewed custody and executed-fee reconciliation. Never use metadata or estimates as payment authority.                                                     |
| F02 | Trading blocker            | No buyback worker, burn execution or recovery ledger exists. Retrying an uncertain transaction could spend twice in a naive implementation.                                                                                                      | Finalized fee ingestion; bounded purchase batches/quote age/slippage; idempotent jobs; settlement recovery; burn only received purchased tokens; verifiable receipts and supply updates.                                   |
| F03 | Trading blocker            | Community mode has allocation math but no full holder indexer, funded claim mechanism or double-claim protection. Creator claims also have no product settlement flow.                                                                           | Complete finalized owner-level snapshots; explicit vault exclusions; funded epoch balances; reviewed claims and retry/double-claim tests. Persist original deployer rights independently of mutable pool-creator fields.   |
| F04 | Trading blocker            | Mainnet configuration has not been created/verified. The old devnet config has dynamic fees and a different graduation fee. `getConfig()` caches one account; launch code does not enforce a reviewed mainnet policy.                            | Use the configuration checker plus full LP/authority review. Require the verified policy at startup/launch, preserve legacy config IDs, rehearse the new config on devnet first.                                           |
| F05 | Trading blocker            | `api/quote.ts` and `api/swap-tx.ts` explicitly reject migrated coins. No complete DBC→DAMM v2 migration/trading rehearsal exists.                                                                                                                | Implement post-graduation quote/swap routing and fee collection; prove buys, sells, rights and price continuity after migration.                                                                                           |
| F06 | High before public trading | Anti-copy and optional-first-buy limits are app/API checks. A user can call the permissionless program directly, race checks, create another wallet or buy later. `burnShare` metadata is not mode enforcement.                                  | State moderation limits accurately; enforce required financial rules in custody/program state. Remove legacy mode data from the new launch contract.                                                                       |
| F07 | High review item           | The fresh production dependency graph reports 13 vulnerabilities: 0 critical, 7 high, 5 moderate, 1 low. Several lie under actual web dependencies, not only Studio.                                                                             | Resolve/replace packages or document tested isolation in the deployed artifact. Complete a runtime reachability review before financial release. See below.                                                                |
| F08 | Medium                     | Launch replay protection, upload concurrency and general API limits are process-local. Restarting/scaling resets or multiplies them. Whitelist nonces and sign-in attempt limits are durable.                                                    | Durable launch entitlements/nonces and per-wallet budgets before opening launch APIs; edge abuse controls and limits on RPC/Pinata costs.                                                                                  |
| F09 | Medium                     | Trades cap at 5,000 signatures, decode the first matching swap event and identify a wallet from the transaction fee payer. Largest-account holder data is incomplete. Footer market stats sample at most eight pools/24 signatures each.         | Keep partial/sample labels. Build a complete finalized event index; identify actual swap owners; never use display history, top accounts or `computePot()` as payment accounting.                                          |
| F10 | Medium                     | `dbc.ts` and trade decoding assume one billion supply, six decimals and one config; market cap does not read supply after burns. Trade-history maps and RPC scans grow with usage; metadata caches are process-bound despite their entry caps.   | Registry/indexer, actual mint supply/decimals, bounded caches and persisted metadata, background refreshes. Dedicated RPC and production-scale load testing.                                                               |
| F11 | Medium                     | Any number of fresh wallets can become verified referrals. Wallet signatures prove control, not distinct people. No airdrop mint/allocation/distribution or claim system exists.                                                                 | Keep referral counts private to the wallet/operator, review farming, freeze an auditable eligibility snapshot before distribution, build distribution separately. Do not publish unimplemented claims or a reward formula. |
| F12 | Medium                     | Admin access is a shared password, not an identity/MFA system. Stateless logout clears one browser cookie; a stolen cookie remains usable until expiry or credential rotation. Distributed invalid attempts can exhaust the global login budget. | Use hosting-account MFA; keep the private setup/rotation procedure; add session revocation, login alerts and stronger owner authentication before administrative money-moving tools exist.                                 |
| F13 | Medium                     | CSP currently restricts frames/base/object, but has no script policy. No nonce-based script policy or edge DDoS protection was verified.                                                                                                         | Test a report-only nonce CSP with wallet flows, then enforce; add edge limits without breaking signed messages. Existing headers are not complete XSS/DDoS protection.                                                     |
| F14 | Release quality            | Root TypeScript check fails with 112 diagnostics under stricter monorepo settings; the app's own check passes. Global format/lint/version-alignment jobs were not all certified green. Work remains largely uncommitted.                         | Fix strict checks without suppressing errors, run every required CI job, review and commit a reproducible release. Passing Heroku/app checks alone is insufficient.                                                        |
| F15 | Operations                 | The inspected slug is about 448.1 MiB and retains a broad workspace dependency tree. Only one web dyno is configured. Monitoring alerts, restore and rollback drills were not verified. Health only proves the process responds.                 | Trace/prune the runtime artifact with Linux smoke tests; monitor HTTP/DB errors and latency; exercise isolated restore and release rollback; add dependency readiness monitoring.                                          |

## Dependency details

Registry findings are not thirteen proven remote exploits. The important remaining paths are:

| Dependency                        | Observed path / concern                                                                                                                         | Next action                                                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `bigint-buffer` 1.1.5             | SPL token buffer utilities; native buffer-overflow advisory. Local inspection uses its JS fallback; Linux artifact behavior needs verification. | Replace/isolate the native path. Never enable the native build merely to remove the fallback warning.                   |
| `stream-json` 1.9.1               | web3.js → jayson; parser/filter DoS and prototype pollution advisories.                                                                         | Check actual transport use and move to a compatible fixed upstream dependency. Do not blindly override a major version. |
| `toml` 4.3.0                      | Anchor; parser CPU/complexity advisories.                                                                                                       | Verify reachable inputs and upgrade compatibly. Public user input must not reach this parser.                           |
| `zod` 3.25.76                     | Direct web dependency; oversized constrained-collection advisory. Current public schemas use bounded scalars and request size limits.           | Review every schema and migrate integrations to a fixed version with contract tests.                                    |
| `image-size` 1.2.1                | Wallet adapter → React Native/Metro tooling; image-parser DoS advisories. The upload decoder uses Sharp instead.                                | Remove unused tooling from the runtime artifact or upgrade the consuming dependency.                                    |
| `csv-parse` 5/6; `elliptic` 6.6.1 | Studio upload/signing dependency trees.                                                                                                         | Keep Studio off the public server path and update the affected tools before operator use with untrusted input.          |

Primary references:
[Meteora program behavior](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/main/README.md),
[Meteora SDK](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk),
[bigint-buffer advisory](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg),
[Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). The local registry scan contains
the other advisory URLs and dependency paths.

## Protections checked

Whitelist registration uses domain-bound, expiring Ed25519 challenges, durable atomic nonce
consumption, parameterized SQL, immutable first-referral attribution and unique wallet records.
Migration tests cover repeatability, code collisions, old-writer compatibility and self-referrals.
Database transport validates certificates. Private APIs/pages check authorization in handlers as
well as middleware; private responses are not shared-cacheable. Secrets stay server-side.

Remote metadata/image requests use a bounded HTTPS host allowlist, no redirects, timeouts,
byte/pixel limits and bounded work queues. Upload requests require wallet signatures and bounded
validated fields. The transaction relay requires a fully signed DBC transaction and never signs for
users; this is not a complete instruction firewall. Mainnet execution remains fail-closed. The
limited source-pattern scan found no matching provider-secret/private-key markers in the searched
code. It was not a full secret-history or hosting-account compromise investigation.

The skill/config validator had two Windows portability defects: URL paths gained a duplicate drive
prefix, and CRLF frontmatter failed parsing. Both were fixed; validation now passes.

## Verification record

- Web app: TypeScript, ESLint and 100 tests passed before the final release checks.
- Root environment tests: 8 passed. New configuration policy tests: 4 passed.
- Offline SDK configuration build: 90% start, no dynamic fee, custom 1.25% migration target.
- Finalized chain inspection: four legacy devnet coins and revoked mint/freeze authorities.
- Isolated database migration regression passed and rolled back its temporary schema.
- Live guest checks: whitelist/privacy/admin/health available; launch/rules redirect; private APIs
  deny access.
- Full monorepo strict TypeScript: failed with 112 diagnostics, retained as an open finding.
- Deployment/browser results are recorded in the release section of
  [LAUNCH-PLAN.md](LAUNCH-PLAN.md).

Provider guidance supports a dedicated RPC for production; public Solana RPC endpoints are
rate-limited. Heroku currently documents a 1000 MB default compressed-slug limit; artifact size here
is an optimization/reliability concern, not evidence that the default limit has been reached. See
[Solana RPC guidance](https://solana.com/docs/references/clusters) and
[Heroku slug guidance](https://devcenter.heroku.com/articles/slug-compiler).
