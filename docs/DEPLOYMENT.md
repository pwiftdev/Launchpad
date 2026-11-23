# Heroku deployment — 26 October 2026

- App: `rinsed-launchpad`
- URL: <https://rinsed-launchpad-1675f6b9bebf.herokuapp.com>
- Dashboard: <https://dashboard.heroku.com/apps/rinsed-launchpad>
- Region: EU
- Runtime: one Basic web dyno, Node 24.22.1, Next.js 15.5.28
- Stack/buildpack: `heroku-24`, `heroku/nodejs`
- Release: `v4`
- Build: `8ab4ff95-a02a-46e6-9977-285c2aaad07d`, succeeded
- Network: **Solana devnet**, verified using the RPC genesis hash
- Source archive SHA-256: `49190ca31031977887ec1b7bd175a32effcb4cb20f962014b9b3363ad6b98144`

The current working tree was uploaded through Heroku's authenticated Source/Build API. Existing Git
commits, the branch, and staged changes were preserved. The repository now has a `heroku` remote
pointing to this app. Subsequent Git deployments require committing the intended files. This
documentation was written after deployment; the archive checksum identifies the deployed code,
rather than subsequent local documentation edits.

Configured server-only RPC and Pinata credentials from the existing local app configuration, the
matching public/server pool keys, `NEXT_PUBLIC_NETWORK=devnet`, and the exact Heroku HTTPS origin
for wallet authorizations and share links. Authentication against Pinata succeeded. Unused R2
credentials and studio signing keys were not transferred. No private keys or `.env` files were
included in the source archive.

The Linux production build completed, the standalone process started successfully, and `web.1`
reported `up`. The release archive is 443.4 MB. Heroku skipped dependency pruning because of the
repository's lifecycle scripts; the process runs the standalone server, but the slug still contains
the installed workspace toolchains. A smaller build-only workspace or post-build cleanup can reduce
future release size.

## Live checks

All **23** checks passed:

- Health endpoint, home page, launch page, logo and legacy launch redirect.
- Coin board (three existing devnet coins), SOL price, trending and dev first-buy quote.
- Brand and coin-specific PNG share images.
- Coin detail page, detail API, holders, trade history and buy quote.
- Unsigned swap transaction construction with a throwaway public address.
- Invalid upload, swap, relay, quote and signature requests rejected with HTTP 400.
- Cross-origin upload rejected with HTTP 403; security headers present on the home page.

No transactions were signed or broadcast, no funds were moved, and no test images were uploaded.
Wallet signing, a funded devnet launch, and full buy/sell confirmation still need an interactive
wallet acceptance test. Existing [audit release blockers](AUDIT.md) remain unresolved; this
deployment is for devnet testing.

## Management

```sh
npx heroku apps:info --app rinsed-launchpad
npx heroku logs --tail --app rinsed-launchpad
npx heroku ps --app rinsed-launchpad
```

Use Heroku Settings to manage secret config values. Changing `NEXT_PUBLIC_SITE_URL` or the public
network requires rebuilding; wallet authorizations are bound to the configured canonical origin.
