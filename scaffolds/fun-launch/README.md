# MSKD.fun

[MASKED](https://mskd.fun) is a Solana launchpad powered by Meteora. Launches can pair with SOL or
hSOL. Dev mode pays creators, Cashback pays holders in the paired asset, and MSKD pays holders in
wXMR. The [launch policy](src/constants/modePolicy.json) defines the fees and payout rules.

## Development

Use Node 24.x and pnpm 10.27.0. Install from the repository root with
`pnpm install --frozen-lockfile`. Copy this workspace's `.env.example` to `.env` and fill in the
private settings for your development environment. Keep mainnet execution disabled during
development. The application uses Pinata for images and metadata, and Postgres for the launch
registry and fee accounting.

From the repository root:

```sh
pnpm --filter @meteora-invent/scaffold/fun-launch dev
pnpm type-check
pnpm test:app
pnpm test:operations
```

The public web app never loads a signing key. Browser wallets sign user launches/trades. A separate
private operator and restricted signer handle company-wallet fee collection and payouts.

## Production

Heroku's `rinsed-launchpad` app serves `mskd.fun`. Its root `Procfile` runs database migrations
during release and starts the Next.js standalone server. `pnpm heroku-postbuild` builds the web
artifact. Changes to public network, pool, or origin settings require a rebuild.

`LAUNCHPAD_PUBLIC` controls public admission. `MAINNET_TRADING_ENABLED` controls new mainnet trading
and preparations. Each active mode uses a verified, registered pool configuration. The registry and
legacy config keys keep historical coins discoverable under their original policies.

After a web release, verify `/api/health` and the launchpad in a browser.
