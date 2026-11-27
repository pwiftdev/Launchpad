# Masked relaunch: go-live checklist

Nothing on this list has been deployed. Per our rule, nothing goes to Heroku or the live site until
the overhaul is finished and you give the go-ahead. Work in order: a gate that fails stops the
relaunch.

## 1. Gates (all must pass)

- [ ] **XMR rehearsal:** 14 days of stagenet payouts to our own wallets, every daily batch on time,
      every claim settled to the lamport ([XMR-PAYOUTS.md](XMR-PAYOUTS.md)).
- [ ] **wXMR rehearsal:** one wXMR payment end to end on devnet: the transaction fits Solana's size
      and compute limits, and settlement matches the chain.
- [ ] **Audit:** third-party review of [AUDIT-SCOPE.md](AUDIT-SCOPE.md); every high or medium
      finding fixed.
- [ ] **Legal:** written answers to [LEGAL-BRIEF.md](LEGAL-BRIEF.md); required changes applied, and
      the campaign's held lines cleared or dropped.
- [ ] **Minimum XMR claim decided** and set as `MASKED_MINIMUM_XMR_CLAIM_LAMPORTS` (default 0.05
      SOL).
- [ ] **wXMR decision:** issuer verified and SOL/wXMR pool depth acceptable, or keep
      `MASKED_WXMR_PAYOUTS_ENABLED` unset (XMR claims then wait during outages).

## 2. Mainnet setup

- [ ] Database migrations through `043` applied with `scripts/migrate.mjs`, and the production
      schema contract check passes.
- [ ] The `masked-v1` launch config created on mainnet and registered, with the company collector as
      fee claimer.
- [ ] Official $MSKD registered with the **same collector**. Check with the wallet operator's
      `status` command: `mskdBuyback.ready` must be `true` with no problems listed.
- [ ] Buyback switched on: the operator config's `scheduler.buyback` sets `maximumSpendLamports` and
      `maximumSlippageBps`. The first burn appears on `/proof` with a receipt.
- [ ] Monero: `monero-wallet-rpc` on the operator machine, private. The hot wallet holds about one
      day of payouts; the rest is in cold storage.
- [ ] `MONERO_ADDRESS_KEY` set to the same value on the web app and the payout operator.
- [ ] `masked-payouts.cjs loop` running: heartbeat fresh, and `/proof` shows the treasury address
      with "The view key matches this address".
- [ ] Treasury topped up with at least a few days of expected payouts.
- [ ] Second RPC provider set as `RPC_FALLBACK_URL`; `DISPLAY_INDEXER=true` on exactly one web
      process.
- [ ] Alerts routed to someone awake: `xmr_payout_alert`, `masked_wxmr_alert`, `masked_epoch_alert`,
      and the wallet operator's alerts.
- [ ] Legacy-mode coins still pay out as before.

## 3. Deploy (needs your go-ahead)

- [ ] Merge `masked-overhaul` into `mskd-rebrand`.
- [ ] Push and deploy.
- [ ] Set `LAUNCHPAD_PUBLIC=true` only after the smoke tests below pass behind the admin login.

## 4. Smoke tests on mainnet, before opening

- [ ] Launch a coin with the slider at 50%; its card shows the locked split.
- [ ] Trade it; the trade appears on the coin page within 2 seconds.
- [ ] After an hour of holding, the holder share shows on My earnings.
- [ ] Claim a small amount in SOL; it arrives and shows as paid.
- [ ] Claim in XMR to our own wallet; it pays in the next daily batch and the day's row on `/proof`
      shows it.
- [ ] `/proof`, `/proof/burn/…` and the key-image download all load without logging in.

## 5. Open

- [ ] Run the [relaunch campaign](RELAUNCH-CAMPAIGN.md), starting with the seeded creators
      ([CREATOR-SEEDING.md](CREATOR-SEEDING.md)).
- [ ] Watch the first daily batch live.
