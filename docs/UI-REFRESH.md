# Price-action backgrounds and market footer

Deployed to `rinsed-launchpad` as release `v9`, build `0bfa35f0-0359-4171-9bee-564881cd051c`, source
SHA-256 `d27b4e31d61d1ad134ebe1ba83da6acf3fe285bbffa1fccf3c8d9c427901c56c`.

The token cards now include faint SVG price-action lines and shaded areas on their right side. The
foreground adds a recent price-change indicator, recent volume and a clearer bonding label.
Comfortable mode uses 64px artwork; compact mode shows more rows. The density preference persists in
the browser. The board also has clearer names, softer panel borders, a coin-count toolbar and a
visible wordmark in the desktop header.

Token detail views add a recent activity summary with volume, swap counts, listed holders and a
buy/sell split by trade count. A faint chart also sits behind the right-side panels. Young coins
start on 15-second candles, and older coins start on one-minute candles.

The footer is available on desktop and mobile. It shows SOL/USD, volume, swap count, quote reserves
in unbonded curves, cluster TPS, server-to-RPC round-trip time and the latest confirmed slot. On
mobile, the stats scroll horizontally and the arrow reveals more values. Page padding keeps the
fixed footer and navigation from covering the end of the board.

## Data meaning and limits

- Sample charts come from the existing fictional trade fixtures. Sample volume and swaps are labeled
  separately; they are not added to actual volume. Preview liquidity includes the board's sample
  curves and is labeled as preview liquidity.
- Live charts and volume come from decoded DBC swap observations, not invented price paths. When no
  recent movement is available, the card gets a flat line and no claimed price change.
- `/api/market-stats` shares one in-flight load and a one-minute cache. It samples up to 24 recent
  transactions from each of at most 8 pools, with a 24-hour cutoff, and reports pool coverage and
  partial results. Volume is presented as recent tracked activity, not a guaranteed full-day total
  or an accounting ledger. The existing decoder's multi-swap/history limitations still apply.
- Cold requests return a pending snapshot after six seconds while the server continues loading.
  Missing values display a dash. Expired snapshots remain available during background refresh.
- TPS uses the configured Solana cluster and includes vote transactions. Devnet is labeled as
  devnet; it does not display mainnet throughput. RPC latency is measured from the server, not the
  visitor's device. SOL/USD is a market reference; devnet SOL has no monetary value.
- No signing keys, fund transfers, token launches or contract changes were involved.

RPC references: [performance samples](https://solana.com/docs/rpc/http/getrecentperformancesamples)
and [transaction results](https://solana.com/docs/rpc/http/gettransaction).

## Verification

59 app tests passed, plus TypeScript and ESLint. Added coverage checks volume arithmetic, the
24-hour boundary, missing data, chart geometry, cache sharing, pool limits and missing RPC samples.
The production Linux build succeeded. All 16 existing HTTP checks still pass.

Browser checks passed on desktop and a 390px mobile viewport using the Slovenian browser locale:
card backgrounds, density changes and persistence, token metrics, chart loading/timeframe,
preview/live footer labels, stats availability, horizontal footer navigation and page overflow. No
browser errors were reported. The live snapshot returned all 3 existing devnet pools with confirmed
slot, performance sample and measured RPC timing. The browser shared the market query across cards
rather than issuing a history query for each card.
