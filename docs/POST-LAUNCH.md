# Post-launch screen and starred tokens

Deployed to `rinsed-launchpad` as release `v10`, build
`45a27d4f-3376-4c91-8904-c5a58de0bfaf`.

The launch completion screen now shows the token artwork and name, a confirmation receipt, a
Solscan transaction link, copy actions, live market cap and bonding progress, and the creator buy
selected at launch. The receipt is created only after the existing transaction confirmation check
succeeds. Missing market data stays visibly pending. The old fixed 27-second message is removed.

Newly confirmed launches are saved in the browser's starred bar. The strip switches to Starred when
a token is added, displays a count, and scrolls manually so followed tokens stay in place. Existing
stars retain their storage key. Small public token metadata keeps a new launch visible while the
board refreshes; uploaded data URLs are not stored. Stars remain browser-local.

The separate watchlist page and navigation links are removed. Old `/watchlist` bookmarks redirect
to the board with the Starred tab selected. Mobile navigation now uses Board, Search, Launch,
Burns and Rules.

On the existing devnet demo deployment, `/launch?preview=success` displays a clearly labeled,
read-only design preview using Bubble Cat. It creates no token, signs no transaction, and does not
automatically star the sample. Transaction and public posting actions are unavailable in preview.
The preview is unavailable when the existing devnet demo feature is disabled.

## Verification

All 59 app tests, TypeScript, and ESLint passed. The production Linux build succeeded and all 16
existing HTTP checks passed. Browser checks at 1536px, 390px and 320px covered the preview,
clipboard, starring and removal, persistence, missing board data, the legacy redirect, ten
manually scrollable stars, mobile search, returning to the launch form and horizontal overflow.
No browser errors occurred. The preview made no calls to launch or transaction creation APIs;
no on-chain launch or transfer was performed during verification.
