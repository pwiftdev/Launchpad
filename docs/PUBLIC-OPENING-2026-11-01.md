# Public opening — 1 November 2026

> Domain update: the [canonical site is now https://plzzz.bond](CUSTOM-DOMAIN-2026-11-01.md).
> The original Heroku address below remains an allowed alias.

> Follow-up: the owner's [TESTCOIN launch](TESTCOIN-MAINNET-VERIFICATION-2026-11-01.md) confirmed
> registration, trades, automatic collections and a finalized buyback/burn. Two execution issues
> discovered during that test were fixed. Bonding and the post-bond lifecycle remain unverified.

The owner explicitly requested public launches be enabled and will perform the next mainnet launch
themselves. Heroku web release **v63** is running with `LAUNCHPAD_PUBLIC=true` and
`MAINNET_TRADING_ENABLED=true`. The web formation was restored to one Standard-1X dyno; the private
operator remains on its existing single Basic worker. No source build was needed for these runtime
switches, and no public build settings were changed.

Launch URL: <https://rinsed-launchpad-1675f6b9bebf.herokuapp.com/launch>.

Live anonymous `/api/launch/status?mode=bond` confirms:

- `canLaunch:true`, `mainnetTradingEnabled:true`, `policyVersion:bond-v1`.
- 99% launch-slot fee, 1.25% curve fee and 1% after bonding.
- One protection slot, with the creator's bundled first buy using the minimum fee.

The verified config remains `2VN1TJVDbw8bxmMTJye8xzdTxVa93Uh8FUSt3UqGcqZ6`, with data SHA256
`2fe8bacae26806bb3bf3aba4cb51332593181da9ba927f6c60b16b2856835f21`. The collector is
`3j4vUdPKF7HNqKoaWdezQoX9Hognn6Us7ua6thZZiaed`; the treasury is unchanged. A finalized check before
opening found 0.09401592 SOL in the collector. Its key remains only in the private Heroku app, whose
automatic operator has a fresh successful heartbeat.

## Checks after opening

- The anonymous launch page opens directly without admin or whitelist enrollment.
- A 0.01% bundled-first-buy quote returns 100,000 tokens for 0.002531884 SOL, including
  0.000031649 SOL fees, consistent with the 1.25% minimum fee and rounding.
- The public anti-vamp check accepts a fresh name/ticker.
- An unsigned invalid upload request returns HTTP 400 after live trading admission, without
  uploading metadata or creating a launch. Pinata authentication also returned HTTP 200.
- The board contains no old or sample coins. Admin APIs still require authentication.
- Real desktop and 390px mobile browser checks passed with no page errors or failed APIs.

No token was launched and no transaction was signed or broadcast during opening verification. The
earlier 611 application and 135 operational tests cover the deployed code; they were not repeated
for this runtime-only change. Full funded lifecycle verification remains pending the owner's
launch, including actual trades, bonding, collection, buyback/burn and creator payout receipts.

Local verification reports are `.local/public-opening-verified.public.json` and
`.local/plzzz-clean-board-browser.public.json`. The pre-opening web settings are retained in an
ignored, access-restricted private backup. Closing `MAINNET_TRADING_ENABLED` on the web disables new
web financial preparations; private operator execution is controlled separately.
