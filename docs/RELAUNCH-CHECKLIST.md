# Masked relaunch: go-live checklist

The production database is on migration `045`. The live site still runs the previous release. Run
the private mainnet smoke test before opening the overhaul to the public.

## Implementation plan

1. Fix fee rounding and the hourly holder cutoff. Test small settlements and buyers arriving after
   the cutoff.
2. Refresh unsigned wXMR quotes and queue open claims independently of coin maintenance. Verify
   recovery across an expired quote, worker restart, and uncertain submission.
3. Make display indexing resume after connection loss and transaction backlogs. Check stale index
   state and remove duplicate work on market reads.
4. Align the web and private worker configuration. Run the local suites and build, then rehearse
   claims, migrations and signing before the private mainnet smoke test.

Unpaid balances and claim history are public on the wallet earnings lookup. Transaction receipts and
aggregate payouts are public on `/proof`. Native Monero payout work is tracked as an upgrade.

## 1. Release checks

- [x] **wXMR rehearsal** completed on devnet. Two expired attempts were reconciled against finalized
      blocks before the replacement paid the wallet once. The recipient balance matched
      [the finalized payout](https://explorer.solana.com/tx/4qJ2YkgfDTzznmTevae11AE6iSa7niWYqNaDBCaRsJPQAnG8qLLRBeiaSDj8q4kKV3vnfLUeuLMPwNxDhWeP7roD?cluster=devnet).
- The owner waived the [independent audit](AUDIT-SCOPE.md) and
  [written legal review](LEGAL-BRIEF.md) for this release.
- [ ] Keep the production wXMR claim minimum at the existing default of 0.05 SOL.
- [x] **wXMR market** checked on 27 November 2026. The issuer's published mint matched the finalized
      Meteora pool. Quotes used the full input and stayed within the 1% price impact limit at 0.05,
      0.1, and 1 SOL. Recheck liquidity in the private smoke test.
      [Issuer's published mint](https://wxmr.io/wrapped-xmr)

## 2. Mainnet setup

- [x] Captured an encrypted production database backup and restored it in an isolated PostgreSQL
      instance before the production migration. Heroku currently points `DATABASE_URL` and
      `MSKD_DEVNET_URL` at the same database. Use an isolated database for devnet work.
- [x] Applied production migrations through `045` with `scripts/migrate.mjs` on 27 November 2026.
      The live schema matches the checked-in contract and the full 17-coin registry matches the
      backup. The live site's health endpoint responded successfully after the migration.
- [x] Created and registered `masked-v1` on mainnet at
      `CWpmVtFanY39bdmULfZHVNu6UrkYNHwmvNFKbhBzEUs3`. Verified the finalized config digest, both
      authorities, and the exact 0.00598408 SOL in rent and fees. The registry entry starts
      disabled.
      [Finalized creation receipt](https://explorer.solana.com/tx/2noy3AyLNDv8g1g9dXGw6w6bbXrU6jTPiahWEXEwVEEgkf7QsF5cJD62uK8ghdqT2yr4Eo56Zeyn42JfvmkRTsY6)
- [x] Preserved the two existing mainnet launch configurations. The public board had 10 Dev coins
      under `56pQWoQgHcAu5Cykb6cEVQ3ifcxFhFyjQcVwe26XsMn` and 7 MSKD coins under
      `8tB1EfQtQnssYr5N3RVjwra1L5myyoumVY3iawCnC6Ld` when checked on 27 November 2026. Keep
      `POOL_CONFIG_KEY` and `MAINNET_MSKD_CONFIG_KEY` at those values for deployment.
- [ ] Set `NEXT_PUBLIC_AXIOM_REFERRAL_URL` before the build if using our Axiom referral link.
- [x] The wallet operator's read-only `status` check against production returned `mskdBuyback.ready`
      with no problems for the official $MSKD mint.
- [ ] Enable the $MSKD buyback by setting the Heroku worker's `WALLET_MAXIMUM_BUYBACK_LAMPORTS` to
      at least `25000000` (0.025 SOL). The live worker's current 1-lamport cap is below the minimum.
      The first burn appears on `/proof` with a receipt.
- [ ] Match the reviewed Masked config and SOL/wXMR pool in the web, operator and signer settings.
      Enable `MASKED_WXMR_PAYOUTS_ENABLED=true` on the web for the private smoke test.
- [ ] Fund the collector with enough SOL for payouts and their transaction and token-account costs.
- [ ] Second RPC provider set as `RPC_FALLBACK_URL`. Enable `DISPLAY_INDEXER=true` on the web. The
      Postgres lock elects one indexer and lets another process take over if its connection ends.
- [ ] Alerts routed to someone awake: `masked_wxmr_alert`, `masked_epoch_alert`, and the wallet
      operator's alerts. Monitor `/api/health?check=display` for a fresh chain clock.
- [ ] Existing display history catches up after migration `044` backfills any older gaps.
- [ ] Legacy-mode coins still pay out as before.

## 3. Deploy (needs your go-ahead)

- [ ] Merge `masked-overhaul` into `mskd-rebrand`.
- [ ] Push and deploy.
- [ ] Enable the reviewed `masked-v1` registry entry with
      `scripts/register-launch-config.mjs     --write --enable` once the new web release is behind
      the admin login.
- [ ] Set `LAUNCHPAD_PUBLIC=true` only after the smoke tests below pass behind the admin login.

## 4. Smoke tests on mainnet, before opening

- [ ] Launch a coin with the slider at 50%; its card shows the locked split.
- [ ] Trade it after reviewing the amount, fee and minimum received. The compact chart reads indexed
      prices when it refreshes.
- [ ] Existing mainnet coins show `MSKDv1` on the board and token page. New Masked coins use their
      locked fee split.
- [ ] Check Helius usage during initial backfill and after it finishes. Public holders refresh
      hourly and the chain heartbeat runs once a minute. The previous web release logged 2,930 RPC
      calls across 39 reports sampled on 27 November, including 1,453 transaction fetches. Compare
      web calls at similar traffic once the initial backfill finishes.
- [ ] After an hour of holding, the holder share shows on My earnings.
- [ ] Claim a small amount in SOL; it arrives and shows as paid.
- [ ] Claim in wXMR to our own Solana wallet. Confirm the actual token amount, paid status and daily
      total on `/proof`. Check that a wallet with a completed SOL claim can claim again.
- [ ] `/proof` and `/proof/burn/…` load without logging in.
- [ ] A wallet's unpaid balances and claim history can be viewed without connecting that wallet.

## 5. Open

- [ ] Run the [relaunch campaign](RELAUNCH-CAMPAIGN.md), starting with the seeded creators
      ([CREATOR-SEEDING.md](CREATOR-SEEDING.md)).
- [ ] Monitor the first wXMR claims and verify their settlement.

## Native Monero upgrade

Before enabling direct XMR claims, fix relay reconciliation, validate supported addresses and review
stored transaction metadata. Then run 14 days of stagenet payouts, verify operator packaging and
alerts, and test treasury funding and public audit exports. See
[the native XMR runbook](XMR-PAYOUTS.md#native-monero-upgrade).
