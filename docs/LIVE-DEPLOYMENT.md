# plzzz.bond live deployment — 31 October 2026

> Current domain: [https://plzzz.bond is live](CUSTOM-DOMAIN-2026-11-01.md) with matching browser
> build, canonical runtime URL and wallet-request origins. Public mainnet launches remain enabled.
> Earlier Heroku-only and disconnected-domain observations below are historical.

> Current: [public launches were opened on 1 November](PUBLIC-OPENING-2026-11-01.md) at the owner's
> request. Mainnet launch status confirms `canLaunch:true`. The owner's [TESTCOIN launch](TESTCOIN-MAINNET-VERIFICATION-2026-11-01.md) verified real trading, automatic fee collection and an
> atomic buyback/burn; bonding and post-bond payout checks remain outstanding. [The clean deployment](BOND-IT-CLEAN-DEPLOYMENT-2026-10-31.md) records the
> new config, private signer and removal of old coins. Earlier closed-gate observations below are
> historical.

> Wallet update: [the main wallet rotation](MAIN-WALLET-ROTATION-2026-10-31.md) records the new
> collector and replacement config candidate. The treasury is unchanged. Keep the Heroku origin
> until the owner elects to connect the custom domain.

> Update: the [Heroku restoration record](HEROKU-RESTORED-2026-10-31.md) documents the successful
> deployment, restored database and running services. The earlier infrastructure observations below
> are retained as pre-restoration evidence. New-config activation and domain DNS remain outstanding.

This is the current release guide. Earlier Rinsed, native-vault and 27-second launch documents are
historical records. New launches use **bond-v1 / Bond it.** only. No new native program deployment
is required. Existing coins retain their original rules.

## Product and fees

| Stage                     | Total trading fee | Allocation                                                                          |
| ------------------------- | ----------------: | ----------------------------------------------------------------------------------- |
| Launch slot only          |               99% | 95% of collected non-protocol income to same-token buybacks/burns; 5% to operations |
| Next slot until migration |             1.25% | 0.95% buybacks/burns, 0.05% operations, 0.25% Meteora                               |
| Graduated DAMM v2         |                1% | 0.50% original creator, 0.30% platform, 0.20% Meteora                               |

Only the creator's first buy bundled with creation pays 1.25% in the launch slot. Subsequent trades
by that wallet have no exemption. There is no seconds-based countdown, dynamic fee, mode selector,
extra platform creation charge or platform migration charge. Network fees and account rent still
apply. The target is 80 SOL in curve reserves; a confirmed migration is needed to finish bonding.

Percentage examples assume the standard protocol share and the launch-owned liquidity. Settlement
uses actual collected income. Outside LPs retain their own fees. The platform's company wallet
executes collections, buybacks, burns and creator payouts; this is not immutable program-enforced
fee routing. Operating expenses use the platform share and retain a pooled 0.01 SOL reserve.

The [implementation note](BOND-IT-IMPLEMENTATION-2026-10-31.md) covers allocation, rounding,
historical compatibility and operating-cost accounting. Meteora's
[launch configuration](https://docs.meteora.ag/core-products/dbc/launch-configurations),
[DBC fees](https://docs.meteora.ag/core-products/dbc/fees/overview) and
[DAMM fees](https://docs.meteora.ag/core-products/damm-v2/fees/overview) describe the protocol
layers.

## Prepared locally; live prerequisites remain

An unsigned mainnet configuration was prepared on 31 October:
`BRbJYYM5txAqhGXsfb3SeYhT2MriNLMjTRZ2j5Y5Qpee`. It is a candidate address, **not a deployed
configuration**. Its private account key and unsigned message are only in the ignored
`.local/plzzz-bond-config-20261031.private.json`. Never include that file in a source archive. The
message's blockhash expires; refresh it before signing, keeping the same account key if this
candidate address is retained.

A finalized read-only mainnet check found:

- Candidate config: absent. The existing local app config is also absent on mainnet.
- Collector `5iskTyXpKn7HeqvNUFBFc1rv2C2EoFNBNyFmXgGFztgS`: **0 SOL**.
- Treasury `GfgpgQa2ZqNm17rJ6fw2t5nBApKKPZBn5M5niWW3riZZ`: 0.000890880 SOL.
- Config account rent estimate: 0.005974080 SOL; estimated two-signature network fee: 0.000010000
  SOL.

These are observations, not funding recommendations or proof of key control. The first collection
also needs a pre-existing fee-payer working balance. Future fee income replenishes it; an empty
wallet cannot submit its first transaction. The rent/fee estimate excludes launch, migration and
ongoing execution costs. Recheck live values before any signing.

The existing Heroku apps were inspected read-only on 31 October. `rinsed-launchpad` has its web
formation scaled to zero; `rinsed-launchpad-operator` has a crashed worker and repeated failure
events. Both still point to the historical `wallet-v1` config
`3FPuMxbaagtAn45zvufthsLkZnSenTPta7nuY7ZVshsE`. Postgres is configured, but a connection using the
current web credentials was rejected with SQLSTATE `28000` because the role is not permitted to log
in. Its schema could not be verified. Restore database login before migrations or acceptance.

The old domain `rinsed.fun` is attached; `plzzz.bond` is not attached to the existing web app. Its
canonical URL still uses the Heroku hostname. The private app has a signer secret configured; it was
not exported or moved into the public app. Signer liveness and key control remain unverified.

A private staged web environment was prepared at `.local/plzzz-bond.web.staged.private.env`,
preserving the existing web secrets and historical config discovery, selecting the candidate Bond
it. config and canonical `https://plzzz.bond`, and closing both public admission switches. All
offline configuration checks pass. The candidate config, database login, domain, worker and funded
acceptance still prevent live readiness. No remote settings, database rows or dynos were changed.
The only transaction signatures in browser tests use an ephemeral local fixture wallet against
mocked APIs; none is sent to Solana.

## Release sequence

1. **Private settings.** Copy [the web template](../deploy/plzzz-bond.web.env.example) into your
   hosting configuration. Replace every placeholder. Use a real mainnet HTTPS RPC, restricted Pinata
   credential and production Postgres. Set the exact canonical origin `https://plzzz.bond`. Keep
   both admission switches false during staging. `ADMIN_SESSION_SECRET` is required for launch
   receipt recovery even without admin sign-in; retain it across deploys so receipts remain
   recoverable. Use independent random registration/recovery secrets.

2. **New Meteora config.** Review the candidate's decoded instructions and fee schedule, verify
   control of the intended collector, refresh the unsigned blockhash, then sign/create the new
   config through the owner's signing workflow. The existing `mainnet:prepare` command prepares a
   new account and unsigned message only; it never signs. Verify the finalized config and pin its
   full data SHA256. Set both `POOL_CONFIG_KEY` and `NEXT_PUBLIC_POOL_CONFIG_KEY` to the verified
   new address. Preserve older keys in `LEGACY_POOL_CONFIG_KEYS` if they should remain discoverable.

3. **Database.** Back up the production database. Apply `node scripts/migrate.mjs` with production
   environment settings, through migration 024. Heroku's `release` process already runs this
   command. Check the resulting schema against `scripts/production-schema-contract.json`. Do not
   regenerate the contract from production. `node scripts/register-launch-config.mjs` is read-only
   by default; with independently pinned `EXPECTED_CONFIG_DIGEST`, `--write` registers the reviewed
   config and `--write --enable` enables its registry entry. These flags change the database and
   belong to the actual release step.

4. **Build and stage the web.** Run `node scripts/deployment-readiness.mjs --env-file PRIVATE_FILE`
   before building. It prints check names without secrets, and does not require admission to be
   open. Build on Linux using `pnpm heroku-postbuild`; Heroku runs it automatically. The public
   network, config key, site URL, sample setting and whitelist setting must match runtime exactly.
   Rebuild when any of them changes. The standalone packager removes traced `.env` files. Do not
   rename or replace an existing Heroku app merely because `app.json` has the new project name.

5. **Private automatic operator.** Build with `pnpm operator:build`, then run `pnpm operator:check`.
   The existing `Dockerfile.operator` and `operator-start.cjs` package an **unsigned planner**; that
   process alone cannot execute buybacks or payouts. For automatic execution, the private operator
   runs `ops.cjs run --execute --automatic` with an approved separate signer command. Review the
   [service template](../deploy/plzzz-bond-operator.service),
   [operator settings](../deploy/plzzz-bond.operator.env.example) and
   [signer command](../deploy/plzzz-bond.signer-command.example.json). Install `ops.cjs` and
   `wallet-signer.cjs` from the same final build on the private host. Supply a private signer policy
   based on `operator-signer.config.example.json`, with verified collector key file, RPC, database
   CA and explicit limits. The service example caps each buyback at 0.1 SOL and slippage at 1%;
   these are example limits, not an owner-approved production configuration. Match signer limits
   before starting. Check the policy using
   `node wallet-signer.cjs --config PRIVATE_POLICY --check-config`, which does not load the key. The
   private command/policy files must be owned by the service account with mode 0600, in directories
   that other users cannot modify. The current Heroku automatic worker bootstrap pins the old config
   address and digest; rebuild that private package with the new verified pins if retaining it.
   Changing its environment alone cannot change those embedded pins. The service template is an
   alternative for a private Linux host and is not a Heroku Procfile. Turn on the worker/mainnet
   gates in **both** private operator and signer settings only after review. Keep all signing
   settings and keys out of the public web process.

6. **Acceptance and monitoring.** Fill the public expectations file from independently reviewed
   mainnet program/config hashes and the final target-platform operator/schema hashes. Run
   `node scripts/production-preflight.mjs --expect-public REVIEWED.public.json --with-database`. For
   funded private acceptance, keep `LAUNCHPAD_PUBLIC=false`, use the configured admin access, and
   enable the reviewed mainnet execution gate on the test web/operator/signer processes. Do not
   expose public admission until acceptance passes. Before public opening, verify one funded launch
   with a bundled creator buy, subsequent buy and sell, confirmed graduation, post-bond 1% trading,
   creator payout, buyback/burn receipts and restart recovery. Verify the 99% launch-slot and 1.25%
   next-slot rules against finalized slots. Confirm real desktop and mobile wallets. Monitor
   `ops.cjs status --execute` on the private host, scheduler heartbeat, failed/manual-review jobs,
   operating reserve, API failures and archive coverage. Test database restore and operator restart.
   The legacy native financial monitor is not the wallet-policy monitor.

7. **Open.** Once acceptance passes and the automatic operator is healthy, set
   `MAINNET_TRADING_ENABLED=true` and `LAUNCHPAD_PUBLIC=true` on the web process. These are runtime
   switches; public build settings still must match. Confirm `/api/launch/status?mode=bond` reports
   `canLaunch:true`, `policyVersion:bond-v1`, correct fees and the expected genesis. Check public
   board, token, launch, rules, registration, wallet and share-card routes. Keep admin routes
   private.

To stop new web trading/preparations, close `MAINNET_TRADING_ENABLED`; to restrict public pages,
close `LAUNCHPAD_PUBLIC`. Stop the private service or close its execution gates separately when
pausing financial operations. Saved signatures must be reconciled before a retry or rollback.

## Local validation commands

```sh
pnpm type-check
pnpm --filter @meteora-invent/scaffold/fun-launch lint
pnpm test:app
pnpm test:operations
pnpm audit:launch-config --template
pnpm operator:build
pnpm operator:check
pnpm heroku-postbuild
node --test scripts/standalone-smoke.test.mjs
```

The standalone smoke test runs against the Linux artifact. Windows builds verify Next.js but do not
produce Heroku's Linux standalone output. A passing local or mocked-browser test does not replace
funded acceptance against the new mainnet config.
