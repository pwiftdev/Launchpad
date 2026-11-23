# Heroku restored — 31 October 2026

The launchpad is online at
[the existing Heroku URL](https://rinsed-launchpad-1675f6b9bebf.herokuapp.com). The plzzz.bond
frontend and Bond it. backend are deployed. Public browsing is open; financial launch/trading
admission and automatic company-wallet execution remain disabled.

## Restored and deployed

- The old Postgres add-on had been removed. Its stale URL caused the login rejection. A replacement
  `heroku-postgresql:essential-0` add-on was provisioned, matching the previous plan.
- The latest retained backup, **a007 from 29 October 2026 at 01:01 UTC**, was downloaded privately
  and restored only into the verified empty replacement database. This recovered 14 registrations, 3
  registered coins and 33 finalized wallet jobs. No existing database was overwritten. Data newer
  than that backup is not claimed to have been recovered.
- Both apps now use the replacement database. Verified TLS reads succeed. The normal release
  migration ran through migration 024; all **56 tables** and the full frozen schema contract match.
- `rinsed-launchpad` runs one web dyno at its existing Standard-1X size. The source release is
  **v55**, followed by the successful **v56** runtime policy update.
- Deployed source SHA256: `cb218c6790732998018684513c79a09b29fbb0995b082c67f6896a5a609db3d1`.
  Heroku's Linux build and release phase succeeded. The compressed slug is approximately 465 MB.
- `rinsed-launchpad-operator` is running again. Recent cycles processed all 3 registered coins with
  zero failures. Automatic signing/relay is off; its existing private signer secret remains in the
  private app, absent from the public web app. The existing reviewed worker package still embeds the
  historical config pins and will need repackaging when the new config is released.

## Live verification

Real production browser checks passed with **no mocked APIs**: anonymous board, current branding and
metadata, single-mode launch form, current rules, mainnet token chart/trades/holders, 390px mobile
layout, PNG share card and private admin routes. The board returns 8 visible markets. Registration
returns the recovered count of 14. No browser errors or failed API requests were observed.

The launch status endpoint returns HTTP 200 with `mode: bond` and `canLaunch: false`, as expected.
The immutable active on-chain config is still the historical wallet-v1 config. It has not been
relabeled or treated as a Bond it. config.

Current web switches:

```text
LAUNCH_POLICY_VERSION=bond-v1
LAUNCHPAD_PUBLIC=true
MAINNET_TRADING_ENABLED=false
WALLET_WORKER_ENABLED=false
```

The private operator has `WALLET_AUTOMATIC_ENABLED=false`. This permits indexing/unsigned planning
while recovered accounting and the new policy are prepared; it does not sign or broadcast jobs.

## Remaining connections

`plzzz.bond` is attached to the app. Its DNS target is:

```text
nameless-peak-x604qirhayrt8wiaogb5h0oh.herokudns.com
```

The domain's nameservers are `nova.dns-parking.com` and `cosmos.dns-parking.com`. Its DNS still
needs to point to that Heroku target; automated certificate issuance is failing until the domain
resolves correctly. Keep the existing Heroku URL as the canonical origin until DNS/TLS works. Then
change the canonical site URL and rebuild, so wallet authorizations and share URLs agree.

The new Meteora Bond it. config still needs to be created and verified, registered/enabled, and
pinned in both app and private worker. Its collector also needs a working SOL balance. Perform
funded launch/trade/migration/buyback/payout acceptance and reconcile any history newer than the
restored backup before enabling automatic financial execution or public financial admission.

The earlier [readiness report](LIVE-READINESS-2026-10-31.md) records the pre-restoration findings.
This restoration record supersedes its database, stopped-process and unattached-domain findings. No
real transaction was signed or broadcast during this restoration.
