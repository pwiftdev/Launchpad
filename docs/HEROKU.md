> Historical reference: new plzzz.bond launches follow
> [the current Bond it. deployment guide](LIVE-DEPLOYMENT.md). Earlier fee schedules, mode choices
> and native-vault instructions below do not configure new bond-v1 launches.

# Heroku deployment

Deploy from the repository root using the classic `heroku/nodejs` buildpack on `heroku-24`. The root
package pins pnpm 10.27.0 and Node 24.x. Heroku runs `heroku-postbuild`; it builds only the web
workspace, then copies public files into Next.js's standalone output. `Procfile` starts that output
on `0.0.0.0:$PORT`. Runtime uses Node directly and does not need pnpm or the studio toolchain.

On Windows, `pnpm --filter @meteora-invent/scaffold/fun-launch build` produces a normal Next.js
build because standalone tracing requires symlink privileges. Preview locally with
`pnpm --filter @meteora-invent/scaffold/fun-launch start`. The root `start` command is for the Linux
standalone artifact.

The app is deployed for devnet testing at
[rinsed-launchpad](https://rinsed-launchpad-1675f6b9bebf.herokuapp.com). It runs in the EU region on
one Basic dyno. See [DEPLOYMENT.md](DEPLOYMENT.md) for the release and verification record.
**Resolve the open release blockers in [AUDIT.md](AUDIT.md) before offering real-money launches or
holder payouts.**

## Configure

The current devnet deployment also includes a [populated design preview](VISUAL-PREVIEW.md) with 25
sample launches. Use the on-page "Hide samples" button to see only real devnet launches. Disable
`NEXT_PUBLIC_DEMO_LAUNCHES` and rebuild to remove the sample feature.

Create a Heroku app in your account, select the Node.js buildpack, and set these config vars in its
Settings page **before the first build**:

| Variable                  | Value                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `RPC_URL`                 | Private HTTPS Solana RPC endpoint. Keep the URL and any API key server-side.                   |
| `PINATA_JWT`              | Server-only Pinata JWT with the minimum upload permissions.                                    |
| `POOL_CONFIG_KEY`         | Existing DBC config address on the same Solana network as the RPC.                             |
| `NEXT_PUBLIC_NETWORK`     | `devnet` for testing; `mainnet-beta` only after the release blockers are resolved.             |
| `NEXT_PUBLIC_SITE_URL`    | Exact public origin, such as `https://your-app.herokuapp.com`, with no trailing slash or path. |
| `IPFS_GATEWAY_URL`        | Optional; defaults to `https://gateway.pinata.cloud`. Use an HTTPS origin.                     |
| `NODE_ENV`                | `production`                                                                                   |
| `HUSKY`                   | `0`                                                                                            |
| `NEXT_TELEMETRY_DISABLED` | `1`                                                                                            |

Do not upload `.env` files, wallet private keys, seed phrases, or studio keypairs. The web app does
not need any signing key. Wallets sign launch authorizations and transactions in the browser. The
existing tracked localnet test wallet is public and must never hold real funds.

`NEXT_PUBLIC_POOL_CONFIG_KEY` is optional for the current board; if set, it must match
`POOL_CONFIG_KEY`. The public network and site URL are embedded during the build: **rebuild after
changing them**. Changing a custom domain also requires rebuilding because launch authorizations are
bound to the origin. Use one canonical domain for launching.

Confirm that the deployed RPC and config use the expected network, fees, decimals, supply,
activation type, quote mint, and migration rules. Startup checks formats and missing variables; they
do not prove those on-chain properties.

## Deploy and verify

With the Heroku CLI authenticated, substitute your existing app's name:

```sh
heroku git:remote --app YOUR_APP
heroku buildpacks:set heroku/nodejs --app YOUR_APP
git push heroku HEAD:main
heroku ps:scale web=1 --app YOUR_APP
heroku logs --tail --app YOUR_APP
```

Review and commit the intended work first: `git push` deploys committed files, not local uncommitted
edits. `app.json` provides equivalent configuration for an app setup flow. The buildpack must
install development dependencies for TypeScript, linting, and the build; do not set production-only
installation options. Leave `PORT` to Heroku. Enable HTTPS on any custom domain before using wallet
authorization.

Check `/api/health` for HTTP 200, load `/` and `/launch`, check `/api/coins` and `/api/sol-price`,
and test a signed launch and buy/sell on devnet with a wallet. The health endpoint checks the web
process only. Transaction submission returns a signature promptly; the browser polls
`/api/transaction-status` before announcing success. If confirmation times out, inspect the supplied
signature before retrying.

## Operating limits

- Start with **one dyno and one Node process**. Request counters, replay protection, caches, and the
  upload budget are process-local and reset on restart. Add a shared Redis limiter/replay store and
  upstream abuse protection before scaling. A reverse proxy must also enforce limits on `/token/*`
  server-rendered requests, which do not pass through the API guard.
- Heroku adds the connecting address at the end of `X-Forwarded-For`. The guard trusts that address
  only when `DYNO` is set. If you put another proxy in front, verify the resulting address chain
  rather than blindly trusting a supplied header.
- Uploads are limited to 2 MB decoded, 16 megapixels, two concurrent uploads, five attempts/IP/hour,
  three valid attempts/wallet/hour, and twenty attempts/process/hour. API traffic is capped at 240
  requests/IP/minute and 1,200/process/minute. These are initial cost controls, not protection
  against a distributed attack.
- Metadata/image downloads accept known HTTPS content gateways and the operator-configured gateway,
  reject redirects, and cap bytes/concurrency. Other hosts and redirecting gateways may yield
  missing images. Use a directly serving IPFS gateway.
- Cache-control `s-maxage` headers alone do not provide a CDN on Heroku. Cold board scans, image
  comparisons, and up to 5,000 trade signatures per pool can exceed the router timeout or exhaust
  RPC quota on busy pools. Move indexing/history and image comparisons to persistent background
  workers for larger datasets.
- `.slugignore` removes art, skills, local env files and studio test fixtures before installation.
  Keep workspace manifests and shared config packages available for the build. The standalone tree
  contains its own traced runtime dependencies; inspect the final slug size because workspace
  installation also brings in studio packages. Build on Heroku's Linux builder, never upload a
  Windows `.next` directory.

Reference: [Heroku Node.js support](https://devcenter.heroku.com/articles/nodejs-support),
[build lifecycle](https://devcenter.heroku.com/articles/nodejs-classic-buildpack-builds),
[HTTP routing](https://devcenter.heroku.com/articles/http-routing).
