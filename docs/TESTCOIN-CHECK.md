# Testcoin image recovery

Deployed to `rinsed-launchpad` as release `v12`, build
`a55ae80a-6201-469a-896d-b4a65cc9bfea`.

Testcoin mint: `CzTxg2nRDQuyPmfyQ3AhP3fha1DXYedURLy8C8vV134e` (devnet).

The launch succeeded and the uploaded artwork was intact. The on-chain metadata points to
`ipfs.io`, which returned HTTP 429 for both the metadata JSON and artwork during investigation.
The server previously cached the resulting null image for the entire process lifetime, and the
avatar stopped trying after one failed image request.

The app now resolves the same IPFS content through Pinata's public gateway first, with safe
gateway fallback. Failed metadata downloads retry after 30 seconds, while successful immutable
metadata stays cached. Concurrent requests share downloads, and slow metadata cannot hold the
entire board offline. Avatars try equivalent gateway URLs, retry after failures, and reset when
their image source changes. New uploads use the same gateway normalization.

The existing destination allowlist, HTTPS requirement, redirect prohibition, download size limits
and concurrency limits remain in place. Regression tests verify that an untrusted host with an
IPFS-looking path cannot become a permitted destination.

The desktop and mobile trade inputs also now have distinct React-generated IDs, so each label
targets its own input.

## Checked

- The recovered artwork is the exact original 1,095,179-byte PNG, verified by SHA-256 comparison.
- The live coin API returns its image URL; the board and token page display it on desktop and mobile.
- Browser checks cover primary-gateway failure, a changed image after failure, and selecting and
  replacing images in the launch form. No launch or transaction submission API was called by
  these browser checks.
- The pool has two finalized, successful transactions: launch with a creator buy, then a sell.
  The trade-history API reports both and the holder API reports the remaining holder.
- Buy and sell quotes return valid results. Both generated unsigned transactions passed Solana
  simulation with `sigVerify: false` and a replaced recent blockhash. Nothing was signed or
  broadcast, and no funds moved during these checks.
- All 73 app tests, TypeScript and ESLint passed. The Linux production build and 16 existing live
  HTTP checks passed.
- Final browser checks on the deployed release confirmed the loaded chart, both trades, the one
  listed holder, the corrected input label and a visible buy quote, with no browser errors.

This verifies the image repair and the checked launch/trading paths. The unresolved economic
features and other findings in [AUDIT.md](AUDIT.md) remain separate release blockers.
