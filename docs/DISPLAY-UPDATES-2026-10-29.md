# Display freshness and TESTDROP artwork — 29 October 2026

Deployed to <https://rinsed.fun> as release **v49**. Source SHA-256:
`87bb8b07a76c800ed9b3acc482492c50399e0bfb6328f55156020a18fe5111ec`.

## Why “Updates delayed” appeared

The live baseline reproduced the warning in two of ten rounds. Both rounds returned successful
coin/ranking reads, zero unavailable ranking scores and no partial ranking coverage. A separate
clock lookup failed and the API combined `clockStale` with the market data's `stale` flag. The top
strip consequently described otherwise usable rankings as delayed.

The former display clock required `getSlot` followed by `getBlockTime` for that latest slot. The
display now reads the confirmed Clock sysvar account directly in one request. It validates the
account owner, layout and timestamp and never substitutes the host clock. The
[Solana Clock sysvar](https://solana.com/docs/core/accounts/account-types) supplies current cluster
time without requiring a lookup of the latest block's indexed timestamp.

Clock freshness and market-data freshness are now separate. Clients still skip clock synchronization
when `clockStale` is true. Genuine list/score failures retain bounded stale data and report them
honestly. The top strip also detects failed requests when React Query retains an older successful
response. Financial quotes, transaction preparation and the private operator's finalized
verification were not changed.

Rankings poll every **5 seconds**, reduced from 20. Their server snapshot cache is also 5 seconds,
reduced from 30. Concurrent viewers continue sharing bounded refresh work.

## TESTDROP artwork exemption

At the owner's request, mint `J21qHBjC2mLQbHL9TQhXBxNn52ViwhgXSKL8urbWMxsq` is excluded from the
image reference set used by anti-vamp comparisons. Its public artwork and on-chain metadata remain
intact. Ticker, name, market and source-post rules still apply. Artwork from other mints remains
protected, including future launches using the authorized artwork.

## Verification

- All 584 app tests passed. TypeScript and modified-file ESLint passed.
- Regression tests prove that a clock interruption does not mark fresh market data stale, while
  genuine ranking/list failures still do. The Clock parser rejects malformed observations.
- Anti-vamp tests prove that TESTDROP's image is skipped, matching artwork from another mint is
  still rejected, and TESTDROP ticker/source checks remain active.
- All 20 post-deployment API checks returned HTTP 200 with `stale=false` and `clockStale=false`.
  After the initial post-deployment cold requests, measured responses took 59–246 ms. Initial cold
  requests took approximately 5–6 seconds; this measurement is not a latency guarantee.
- A real anonymous browser observed ranking refreshes about five seconds apart on v49. An outage
  simulated only in that browser produced the warning; restoring requests cleared it. Desktop and
  390px mobile checks completed without browser errors.

Private evidence: `.local/update-delay-baseline.private.json`,
`.local/update-delay-after.private.json`, `.local/update-delay-browser.private.json` and
`.local/update-delays-release.private.json`.
