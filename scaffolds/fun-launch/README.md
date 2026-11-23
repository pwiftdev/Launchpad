# plzzz.bond

The Meteora-powered Solana launchpad. Every new launch uses **Bond it.**: a one-slot 99% guard, then
1.25% curve trading with same-token buybacks/burns, followed by 1% trading and creator rewards after
bonding. Only the creator's bundled first buy pays 1.25% during the launch slot.

Start with [the current deployment guide](../../docs/LIVE-DEPLOYMENT.md) and
[the backend policy](../../docs/BOND-IT-IMPLEMENTATION-2026-10-31.md).

## Development

Use Node 24.x and pnpm 10.27.0. Install from the repository root with
`pnpm install --frozen-lockfile`. Copy this workspace's `.env.example` to `.env` and fill in the
required private settings. Keep mainnet execution disabled during development. The application uses
Pinata for images/metadata and Postgres for registration and fee accounting; R2 is not used.

From the repository root:

```sh
pnpm --filter @meteora-invent/scaffold/fun-launch dev
pnpm type-check
pnpm test:app
pnpm test:operations
```

The public web app never loads a signing key. Browser wallets sign user launches/trades. A separate
private operator and restricted signer handle company-wallet collection, buybacks/burns and payouts.
The unsigned planner alone does not execute financial jobs. See the deployment guide for the
automatic operator configuration.

## Production

The root `Procfile` runs database migrations during release and starts Next.js's Linux standalone
artifact. `pnpm heroku-postbuild` creates that web artifact. Set public network/config/origin
settings before the build; changing them requires a rebuild. Windows builds verify Next.js but do
not create Heroku's Linux standalone package.

`LAUNCHPAD_PUBLIC` controls public admission. `MAINNET_TRADING_ENABLED` controls new mainnet
trading/preparations. Both default to false. The active config must be an independently verified,
registered, enabled `bond-v1` config. Historical coins retain their original policy and remain
discoverable through the registry/legacy config keys.

No funded acceptance, migration application or production deployment is implied by local tests.
Current infrastructure blockers and the release sequence are recorded in the deployment guide.
