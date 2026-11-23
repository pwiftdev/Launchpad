# plzzz.bond readiness check — 31 October 2026

The local application is prepared for a release review. **Production activation remains blocked.**
Use [the deployment guide](LIVE-DEPLOYMENT.md) for the current configuration and release sequence.

## Completed locally

- Launch form and signed payload use only `bond` / **Bond it.**, with `burnShare: 0`.
- Homepage, wallet metadata, rules, launch preview, fee cards and API errors use plzzz.bond and the
  new economics. Historical fee views remain clearly labeled; historical receipt/signature protocols
  and storage keys stay compatible.
- Launch receipt storage now accepts the new mode, including reload recovery after a lost relay
  response. The creator rewards panel accepts bond-v1 and displays funded creator payouts.
- Normal curve fees are labeled 1.25%; graduated fees are labeled 1%. The 99% launch-slot exception
  and bundled creator-buy exception are disclosed without guessing slot completion from seconds.
- Slot-based quote and swap preparation no longer depend on a block timestamp being available.
- Startup checks require Postgres, company recipients and the launch recovery secret for bond-v1. A
  separate offline deployment check verifies production settings without displaying secrets.
- API tests were moved out of Next.js's route directory. They remain in the application suite and no
  longer become unintended public routes or invalidate generated route types.
- Prepared a private staged environment using the existing web credentials, preserving historical
  config discovery and closing admission. No remote environment settings were changed.
- Prepared an unsigned candidate Meteora configuration and rebuilt the separate operator artifacts.
  Added deployment examples for web settings, private operator settings, signer invocation and a
  supervised automatic Linux service. Example limits require review before use.
- CI's offline Meteora audit now receives explicit public company addresses. Older release guides
  point to the current Bond it. guide instead of silently mixing economic versions.

## Verification

| Check                                       | Result                                                  |
| ------------------------------------------- | ------------------------------------------------------- |
| Full application suite                      | **605 passed**                                          |
| Operational suite                           | **127 passed**                                          |
| Workspace TypeScript                        | Passed                                                  |
| Full application ESLint                     | 0 errors; 29 scaffold warnings remain                   |
| Changed-file formatting and diff whitespace | Passed                                                  |
| Optimized Next.js production build          | Passed on Windows with mainnet public settings          |
| Offline Meteora template audit              | Exact 99% launch slot → 1.25%; no policy issues         |
| Staged production settings                  | All offline checks pass; admission disabled             |
| Standalone operator and startup portability | Passed; no signatures or transactions                   |
| Edge browser, production build              | Desktop and 390px mobile checks passed with mocked APIs |

Browser acceptance exercised anonymous access, correct copy and metadata, Phantom fixture
connection, a signed launch payload, a deliberately lost relay response, saved receipt recovery
after reload, pre-bond and post-bond fee/reward views, responsive pages, actual branded
assets/share-card rendering, and protected admin routes. It used a new ephemeral fixture wallet and
mocked all application APIs. No fixture transaction was sent to Solana. These checks do not
establish funded mainnet acceptance.

Windows does not produce the Linux standalone web artifact in this repository. The Linux/Heroku
build and standalone smoke job still need to run for the actual release. Lint warnings are in
inherited scaffold code, mainly unused values and explicit `any` types; they were not hidden.

## Live blockers observed read-only

1. **Database login is blocked.** The configured production Postgres role is not permitted to log in
   (SQLSTATE 28000). Production schema and migration 024 could not be verified or applied.
2. **Web/operator processes are unavailable.** The web formation is scaled to zero. The private
   worker is crashed and repeatedly reports `PRIVATE_WORKER_REPEATED_FAILURE`.
3. **The new config is undeployed.** Candidate `BRbJYYM5txAqhGXsfb3SeYhT2MriNLMjTRZ2j5Y5Qpee` does
   not exist on mainnet. Both existing apps still use the historical wallet-v1 config. The old
   private bootstrap also embeds those old pins.
4. **The collector is unfunded.** Its finalized balance was 0 SOL. Solana needs a fee-payer balance
   before config creation and the first collection; later operating income can replenish it.
5. **The new domain is unattached.** The existing app has rinsed.fun and its Heroku hostname;
   plzzz.bond must be attached with working DNS/TLS and the canonical URL rebuilt.
6. **Funded acceptance is outstanding.** Real new-config launches, slot boundaries, trades,
   graduation, buybacks/burns, creator payouts, operator recovery and mobile wallet signing must be
   confirmed before public activation.

No production database writes, dyno changes, config updates, deployments or real signed/broadcast
transactions were performed. The owner's earlier decision to decline an outside audit remains
unchanged; no outside audit is claimed or added as a new approval requirement.
