# Populated launchpad design preview

The Heroku app includes 25 fictional sample launches alongside the existing devnet launches: 10 New,
9 Close to bonding and 6 Bonded. Each has original artwork, a short description, a distinct market
cap, age, progress, simulated trade history, chart and holder list.

Samples carry a DEMO badge and a detail-view explanation. Trading, explorer links and promotional
sharing are unavailable for sample coins. Their `demo-*` IDs cannot pass the transaction schemas.
The API and on-chain moderation layer still return only real launches; preview data is composed in
the presentation hooks. The feature requires both `NEXT_PUBLIC_NETWORK=devnet` and
`NEXT_PUBLIC_DEMO_LAUNCHES=true`. The banner toggle hides samples and remembers the choice in the
browser. Change the environment flag and rebuild to remove the preview altogether.

## Artwork

Generated with the built-in `image_gen` tool, one prompt per image. The complete prompt template and
25 subject prompts are saved in [demo-artwork-prompts.json](demo-artwork-prompts.json). Optimized
final assets are in `scaffolds/fun-launch/public/demo/coins/`: 25 square 256px WebP images, 365,404
bytes in total. The original generated PNGs remain in the local Codex generated-images directory.
Only the optimized assets are served by the app.

## Suggested visual direction

Keep the three-column board and build around stronger artwork and clearer hierarchy:

1. Add a comfortable density option with 64px artwork, clearer names and a little more space per
   row. Retain compact mode for scanning more launches at once.
2. Raise the contrast of coin names and secondary labels. Make the order of attention deliberate:
   image, ticker/name, market cap, then age and progress.
3. Add a small sparkline and change indicator where real indexed history is available. For young
   coins, choose a shorter initial candle interval so a three-minute history has more than three
   oversized candles.
4. Use slightly lighter navy panels, softer dividers, consistent corners and a restrained stage
   accent. The artwork can carry most of the color.
5. Give the header a clearer rinsed.fun wordmark. A compact featured-launch area could provide a
   focal point without replacing the board.

These are discussion points, not a broad redesign already applied. The populated board gives us a
realistic view of density, artwork, stage balance and detail panels before choosing changes. The
hierarchy, contrast and grouping direction is consistent with
[NN/g's visual hierarchy guidance](https://www.nngroup.com/articles/visual-hierarchy-ux-definition/).

## Verification

52 app tests passed, along with TypeScript and ESLint. The tests cover unique marked samples, stage
distribution, deterministic finite chart data, mainnet exclusion and rejection by swap validation.
The Linux preview build succeeded. The existing 16 live HTTP checks still pass.

All 25 artwork URLs return WebP successfully. Desktop board rendering, a sample chart with 96
simulated trades, direct sample links, the sample toggle, persistence and mobile tabs were checked
in a real browser with the Slovenian locale. Saved preferences use the existing hydration-safe
storage hook, and financial number formatting now has a consistent locale on the server and in the
browser. Final browser verification reported zero errors and zero sample requests to the on-chain
coin API. No on-chain launches, signed transactions or artificial trading activity were created.

Final release: `v8`; build `172b3541-d296-4e3f-8fc2-82ad190cb08a`; source SHA-256:
`9f25dc0de9ba635c5e85bf0364ff8f79b1029a5d22c4c75990dde2db69e7938a`.
