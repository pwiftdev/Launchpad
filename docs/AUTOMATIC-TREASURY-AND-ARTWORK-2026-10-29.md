# Automatic treasury withdrawals and artwork recovery — 29 October 2026

Live on <https://rinsed.fun> as web release **v45**, with the updated private operator running. The
initial automatic batch sent **0.074868891 SOL** to treasury
`GfgpgQa2ZqNm17rJ6fw2t5nBApKKPZBn5M5niWW3riZZ` in four finalized transactions.

## Treasury schedule

The private operator checks each coin during its normal cycle, roughly every 15 seconds. It queues
one platform withdrawal per coin per quarter-hour window, using finalized chain time. Windows start
at minute 00, 15, 30 and 45. Execution can follow the boundary while earlier signed transactions
finalize. An existing in-flight withdrawal is resumed, never replaced with a duplicate.

The stable `platform:quarter-hour:WINDOW` intent survives process restarts. A completed or failed
attempt is not recreated in the same window. Only funded, unreserved platform income is withdrawn;
creator, Community and buyback balances remain separate in the ledger. The existing 1 SOL payout
limit remains in place per coin per window; larger balances carry into later windows. Empty balances
create no transaction. The fixed treasury remains the sole platform recipient.

| Launch    | Initial automatic treasury payment (SOL) |
| --------- | ---------------------------------------: |
| TESTDROP  |                              0.010389315 |
| HEARTDROP |                              0.006281128 |
| CURSED    |                              0.058146729 |
| TESTCOIN  |                              0.000051719 |

[CURSED treasury receipt](https://solscan.io/tx/27hE5kPPV7WwYMwTs3e3rHsgft5mi9Vyn71UEVw1gJJ14J7bhXgZ1FkR7EJbQE2ZGTYbNFgGg5PyCFiSZCqpFisG).

All four payments were independently checked against finalized mainnet transactions. At the closing
check, every platform balance was paid and no payout reservation remained. Signing material stays in
the private operator app; the web app has no signing key. The temporary private deployment backup
containing the signing configuration was deleted after restoration was verified.

## Buybacks

New buyback budgets below **0.025 SOL** are held without reserving or spending them. The planner and
independent signer enforce the minimum. Small balances remain in their token's buyback bucket until
sufficient income accumulates. Historical completed burns are unchanged.

The previous 0.01 SOL maximum would have prevented any buyback from reaching the new minimum, so the
private per-buyback maximum is now **0.05 SOL**. Treasury and creator payout caps are unchanged. No
new buyback below the minimum budget was created after activation.

## Artwork fixes

Two causes were reproduced:

- Public IPFS image gateways can be slow or rate limited; the fallback gateway returned HTTP 429.
- The metadata reader supports descriptions and social links, but the database constraint allowed
  only image, source and description. TESTCOIN's valid social metadata was rejected, so its image
  never entered the durable metadata cache. Comparing JSON objects by property order also caused
  valid expanded metadata to be treated as damaged.

The schema now accepts the bounded sanitized social fields, and metadata comparison ignores property
order. Artwork is decoded to static WebP and stored in a bounded database cache, with a bounded
memory cache and HTTP caching. Browsers request `/api/token-image` first and retain direct gateway
fallbacks. The endpoint accepts only approved metadata destinations, limits downloads and image
dimensions, and rejects executable or non-image content. New uploads seed both caches directly.
Existing artwork and metadata were backfilled for all four real launches.

## Verification

- 578 app tests passed before the final metadata regression; all 14 focused cache tests passed after
  the schema/property-order correction, including a restart with descriptions and socials.
- TypeScript passed. Full-app ESLint had zero errors and 29 existing warnings; final cache files
  also passed ESLint. Isolated migration/schema tests passed.
- All four images loaded on actual token pages and the 390px mobile board while browser access to
  external IPFS gateways was blocked. Conditional requests returned 304; unsafe source URLs
  returned 400. No browser errors were recorded.
- The final web release and operator were up. Health, both launch modes, quotes, burns and creator
  rewards passed live reads. The closing worker cycle processed four coins with zero failures.
- Source SHA-256: `7d9dcdd09fe4992fea6715cb69cee3de1314cfb5edad33c574701f4a210392ba`.

Private receipts and deployment evidence remain under ignored
`.local/automatic-treasury-verification.private.json`, `.local/treasury-images-browser.private.json`
and `.local/treasury-images-completion.private.json`.
