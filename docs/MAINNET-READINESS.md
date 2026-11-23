> Historical reference: new plzzz.bond launches follow
> [the current Bond it. deployment guide](LIVE-DEPLOYMENT.md). Earlier fee schedules, mode choices
> and native-vault instructions below do not configure new bond-v1 launches.

# Mainnet preparation

Current local implementation and release requirements are in
[the 28 October build status](BUILD-STATUS-2026-10-28.md). The owner has paused Heroku deployments
until mainnet testing is ready. The material below records the earlier promotion setup and its
verification; it is not evidence that the new financial program is deployed to production.

Current status and next build order: [project audit](PROJECT-AUDIT-2026-10-27.md) and
[28 October launch plan](LAUNCH-PLAN.md). Starting tax is 90%; the public campaign stays
whitelist-only while financial execution is completed and reviewed.

The 90% tax/copy update was verified live on `rinsed-launchpad` release 25. Current release
verification is in [LAUNCH-PLAN.md](LAUNCH-PLAN.md); exact build/release identifiers are kept in
private `.local/heroku-state.json` to avoid a source/build identifier cycle.

## Available now

The visual identity uses the supplied bubble mark and gradient wordmark from
`scaffolds/fun-launch/rebrandedimages`. Originals stay unchanged. Run
`node scripts/prepare-brand-assets.mjs` locally after replacing source artwork to produce the
optimized WebP UI assets, PNG wallet/share-card icons, favicon and Apple touch icon. The shared
brand components and `BRAND.assets` choose these files throughout the site. The legacy logo URL also
serves the new bubble mark. Public access permits only the explicitly listed brand assets; the
launchpad remains behind the admin gate.

The updated cyan, magenta and violet palette covers both themes, wallet UI, chart accents,
background particles, loading states and share images. Trading gains/losses retain their semantic
green/red colors. Navigation avoids duplicating the wordmark when the desktop rail is expanded. The
rollout passed app tests, TypeScript, ESLint and environment validation. Live browser checks covered
the public whitelist and private board, expanded navigation, token/chart, launch and success
screens, rules, burns, privacy, admin entrance, wallet/install/onboarding screens, favicons and
share card in both themes and mobile layouts. Public assets load without granting launchpad access.
The admin gate was rechecked, and the temporary review session was signed out.

The wallet-verified early-access page is `/whitelist` on the existing Heroku app. It accepts
registration interest and a domain-bound, expiring message signature. Registration does not create a
blockchain transaction, approve spending or reserve tokens.

Registrations live in Heroku Postgres Essential-0, separately from app restarts and deployments. The
database is $5/month at the provider's published maximum monthly price. Daily logical backups are
scheduled at 02:00 Europe/Ljubljana; provider continuous protection is also enabled.

The registry records public wallet, interest, status, time, verification message and signature. It
does not collect email addresses, recovery phrases or private keys. Raw IP addresses are not stored
in the registration database. Abuse buckets use keyed hashes, with persistent expiry and limits. See
`/privacy` for the visitor notice.

The registration flow verifies Ed25519 signatures, atomically consumes each nonce, preserves the
first receipt on duplicate registration, and keeps private status behind a secure HTTP-only signed
session cookie. No public wallet-list or wallet-enumeration endpoint is exposed.

Referral links use `/w/CODE` and redirect to the whitelist. The signed challenge includes the
validated invite code, and only the first registration can assign an inviter. Duplicate signatures
preserve the original receipt and referral attribution. Unknown, revoked and self-invites do not
earn credit. The public API exposes the active-wallet total and a shortened inviter address; the
owner's referral total remains behind the registration cookie. A referral proves a wallet joined,
not that it belongs to a distinct person. Whitelisters will receive the planned $RINSED airdrop, and
successful referrals increase their allocation. No token amounts, percentages, referral tiers or
allocation formula are published. Claims and distribution are not implemented; the site does not
offer a claim transaction. Fee discounts and the earlier proposed badge/tool reward tiers are
superseded by this airdrop policy.

## Operating the list

The public entry point now redirects to `/whitelist`. Launchpad pages (including token pages, rules
and burns), market data and trading APIs require admin authentication. The registration page,
privacy notice, referral redirects, brand image, health check and `/admin` login remain available.
The whitelist and privacy pages do not link to or render the launchpad shell.

Admin access fails closed when credentials are absent. There is no default key and no public setup
endpoint. The owner chooses the key privately from a local interactive terminal:

```sh
node scripts/setup-admin.mjs
```

Run it from the repository root with the Heroku CLI already logged in. The command asks for the key
twice without echoing it, uploads only a salted PBKDF2 hash and an independent session signing
secret, and restarts the existing Heroku app through its config update. It does not print the key or
put it in a URL, command-line argument, source file or public environment variable. Then visit
`/admin` to enter the launchpad. The owner's chosen key has now been configured at the owner's
explicit request. Run the command again to change it. Only the salted hash and session signing
secret are stored in Heroku; the password is not recorded in this document.

Admin sessions expire after eight hours and use a host-only, Secure, HTTP-only, SameSite=Strict
cookie. The lock button signs out the current browser; running setup again rotates credentials and
invalidates all older sessions. Sign-in attempts use persistent keyed network limits. The login
fails closed if storage is unavailable. Private HTML/data and API responses are not shared
cacheable. Each private page renderer and API handler checks the session as well as middleware. The
admin key does not enable mainnet financial execution.

`NEXT_PUBLIC_SITE_URL` holds a single canonical HTTPS origin. Additional explicitly allowed domains
are in the server-only `SITE_ALLOWED_ORIGINS` setting. Both attached domains remain supported;
redirects stay on a recognized host, and wallet challenges bind to the approved request origin.
Unknown origins and lookalike domains remain rejected.

The implementation uses the supported
[Node middleware runtime in Next.js](https://nextjs.org/docs/15/pages/api-reference/file-conventions/middleware)
and salted PBKDF2-HMAC-SHA256 with the work factor documented in
[OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

The gate passed 97 app tests, TypeScript, ESLint and eight environment checks. An isolated browser
test used temporary in-memory credentials to verify incorrect-key rejection, valid login, cookie
flags, private caching, session persistence, sign-out, mobile layouts, forged headers and framework
data routes. The private setup command was tested with simulated Heroku settings; it hid both
entries and sent only the hash and session secret. Those isolated tests did not configure any real
admin key. Live checks passed on both attached domains: guests reach the whitelist, private
HTML/data redirects and APIs reject unauthorized access, the privacy page has no launchpad shell,
and unconfigured admin login stays closed. The local development preview remains available. The full
signed-wallet registration/referral flow also passed on `https://rinsed.fun`, including copy/share
links, duplicate protection and comparison with the private operator report. Synthetic registrations
were removed afterward. The owner's chosen credentials were subsequently configured through the
private setup prompt. Live sign-in, private API access, page reload and sign-out were verified on
both attached domains; anonymous visitors remain restricted to the whitelist. Test browser sessions
were signed out afterward. No raw password was saved to source files or app settings.

Run `node scripts/whitelist-export.mjs` in a Heroku one-off dyno to export wallet, receipt,
interest, status, registration time, invite code, inviting wallet and referral count as CSV. Keep
exports private. A record's `registered` status proves wallet registration, not a token allocation
or permission to spend funds. `approved` and `revoked` are reserved for access administration;
mainnet admission must check the authoritative record.

For the private per-wallet referral stat, use the operator report:

```sh
heroku run --no-tty --app rinsed-launchpad "node scripts/whitelist-export.mjs --referrals"
```

This CSV includes active wallet, verified referral count, invite code, status and join time, sorted
by referral count. It uses the same active-registration count as each wallet's signed receipt;
duplicate registrations add no credit and revoked registrations do not count. Access requires
Heroku/database credentials. There is no public operator report or wallet leaderboard. Review farmed
registrations before determining final allocations. No mint, token supply, distribution date or
reward amounts have been configured by this change.

The airdrop announcement and invite-share copy were verified on the deployed whitelist, along with
signed registrations, referral attribution, duplicate/self-referral protection and mobile layouts.
The private referral report was compared against synthetic signed registrations and matched the
receipt totals without duplicate credit. Test registrations were removed afterward. The
wallet-message purpose and privacy notice now explain the use of referrals for the airdrop. The
deployed `--referrals` export was exercised successfully in an authenticated Heroku one-off dyno. A
current private CSV is saved locally at `.local/whitelist-referrals.csv`; refresh it from the
workspace with `node .local/export-referrals.cjs` while the Heroku CLI is logged in.

Schema migration runs in the Heroku release phase. It is transactional, takes an advisory lock, and
is safe to repeat. A failed migration stops release. TLS certificate and hostname validation stay
enabled. Runtime code and migration use the Heroku stack trust store; external clients must provide
the AWS RDS global CA bundle with `DATABASE_SSL_CA`.

To honor a deletion request, verify the requester's wallet using a fresh signed message, then remove
only that wallet's entry and challenges. Do not change registration records based only on a public
address supplied by an unauthenticated requester. Provider backup retention still applies. Deleting
an inviting entry also clears its wallet from other entries' `referred_by` field.

## Agreed mainnet product behavior

- A gradual RINSE starts at 90% and reduces to a nominal 1.25% over 27 seconds. Verify the exact
  SDK-generated on-chain endpoint, including integer scheduler rounding.
- Dynamic trading fees are disabled, including after migration.
- The RINSE buyback budget buys the launched token after RINSE, in bounded batches. Purchased tokens
  are burned. No RINSE holder payout, holding-period test, bond payout or 72-hour settlement
  remains.
- Creator Fees mode accrues the mode allocation for the original deployer after RINSE.
- Community mode accrues the mode allocation for hourly holder snapshots and funded SOL claims.
- Marketing describes total fees, mode behavior and execution status without publishing internal
  allocation details. On-chain operations remain independently inspectable.

Server-side integer accounting for this policy is in `src/server/economics/feeLedger.ts`. It
separates executed protocol/referral fees, RINSE buyback budgets and post-RINSE mode allocations. It
conserves lamports, combines token accounts by owner, excludes known vault accounts, carries
undistributed dust forward, and refuses incomplete or unfinalized holder snapshots. It is not a
funded vault or payment executor. Existing estimated pot calculations are not payment accounting.

## Required before enabling financial mainnet operations

| Work item                 | Acceptance evidence                                                                                                                         | Current state                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| New mainnet configuration | Correct genesis, verified fee schedule, no dynamic fee, intended migration fee/LP rules and supply authorities                              | Pending creation and verification              |
| Fund custody and routing  | Deployed/reviewed vault or program with fixed entitlements, per-coin mode records, controlled authorities and no discretionary reassignment | Not implemented                                |
| Buyback executor          | Finalized fee ingestion, funded budget, bounded quote age/slippage/size, idempotent execution and failed-transaction recovery               | Not implemented                                |
| Burns                     | Burn only received purchased tokens; finalized burn receipts; mint supply and displayed market cap updated after burns                      | Not implemented                                |
| Holder snapshots          | Complete finalized owner-level balances for all holders; pool/LP/burn exclusions; exact epoch boundaries and no top-20 approximation        | Not implemented                                |
| Claims                    | Funded epoch accounting, deterministic allocation, double-claim protection, rollover and verifiable claims                                  | Not implemented                                |
| Graduation                | Complete devnet rehearsal through DAMM v2, preserved fee rights and working post-graduation trading                                         | Not rehearsed                                  |
| Treasury operation        | Reviewed authority ownership, signer custody, key rotation/incident plan and withdrawal permissions                                         | Requires operational setup                     |
| Security/dependencies     | Resolve or isolate remaining audit findings and review the financial execution implementation                                               | Earlier audit findings remain open             |
| Mainnet access            | Verified registered/approved wallets enforced at the intended access points                                                                 | Registry exists; financial access stays closed |

There is no Rust/Anchor financial program in this repository today. The existing Meteora fee-sharing
helper supports small fixed recipient sets and does not implement arbitrary hourly holder lists. An
execution/claim design must be selected and built before funded claims can be advertised.

The mutating launch/swap/relay APIs now check the actual RPC genesis and allow only the existing
devnet preview. A configured network name cannot bypass that check. Mainnet remains fail-closed,
including if an environment flag is changed. Opening registration does not open trading.

Old devnet coins retain their original settings. A new config rollout must retain support for old
config IDs and read each coin's actual fee parameters; changing one shared environment key must not
hide existing coins or relabel their fee history.

## Verification

The current deployment passed 87 app tests, TypeScript, ESLint and six environment checks. Live
browser checks covered wallet connection and message signing, cancellation, receipt recovery after
reload, invalid signatures, nonce replay and concurrent replay, duplicate registration, cross-origin
rejection, anonymous privacy, 1536px desktop and 390px/320px mobile layouts. No browser errors or
financial transaction calls occurred. Synthetic test registrations were deleted by exact
wallet/receipt ID.

Four additional accounting tests cover both modes, the RINSE boundary, referral/rounding
conservation and owner-level holder allocation. Mainnet financial execution has not been tested or
enabled. Refer to [AUDIT.md](AUDIT.md) for the remaining release findings.

The production dependency scan still reports 13 advisories: zero critical, seven high, five moderate
and one low. These are dependency-graph findings, not proof that each is remotely exploitable
through the whitelist. They remain part of the financial release review.

The deployed operator CSV export was exercised successfully, the backup schedule was read back from
Heroku, and the database connection was verified with TLS 1.3. No synthetic registration remains in
the list. No public posts or direct messages were sent to advertise registration.

The referral review passed 87 app tests, TypeScript, ESLint and six environment checks. Isolated
database checks cover colliding receipt prefixes, repeatable migration, insert compatibility with
the previous release, self-referral rejection and referral detachment on deletion. Browser checks
cover signed invites with a failed optional inviter lookup, duplicate-count accuracy, immutable
attribution, short-link normalization, copy/share links and signature tampering. Live release
verification passed against the latest deployment above, along with all 16 endpoint checks. All
three synthetic test registrations were removed afterward; the database was verified empty with TLS
1.3. Mainnet financial execution remains closed.

The shared wallet picker now uses rinsed.fun branding through the wallet adapter's supported footer
attachment and scoped CSS. Production browser checks cover the whitelist, board and launch entry
points; installed-wallet connection and disconnection; install and onboarding screens; light/dark
themes; 320/390/844/1440px layouts; readable wallet names; keyboard focus; and Escape, close-button
and outside-click dismissal. No signatures or financial transactions were requested. Recheck these
screens when upgrading the wallet adapter; the styles do not depend on generated Emotion class
names. Earlier badge and premium-tool reward proposals have been replaced by the $RINSED airdrop
policy above.
