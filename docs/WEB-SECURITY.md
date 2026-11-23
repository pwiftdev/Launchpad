# Web security and operator controls

These changes are local source changes. They do not rotate production credentials, change hosting
configuration, delete uploads or release mainnet transactions.

## Script execution policy

Middleware generates a fresh 24-byte random script nonce for every document request and replaces any
client-supplied nonce/policy header. The same nonce reaches Next's document scripts, the initial
splash script and the theme provider. Pages render at request time; the response is private and not
cacheable. This deliberately gives up automatic static-page optimization so a cached HTML document
cannot carry a nonce belonging to a different response.

Production script policy excludes `unsafe-inline` and `unsafe-eval`, blocks inline event attributes,
objects, framing the application and off-site form submissions. Chart/component positioning and
wallet portals still require inline CSS; `style-src` therefore permits inline styles. HTTPS image
and connection sources remain broad for token metadata and wallet integrations. Supported wallet
iframe origins are explicitly listed. Development alone permits eval-based bundling and loopback
HTTP/WebSocket connections. Browser production verification must include wallet connection, client
navigation, theme loading and charts.

The implementation follows the
[Next.js nonce guidance](https://nextjs.org/docs/pages/guides/content-security-policy). Middleware
and policy tests check header replacement, per-response uniqueness and the production script
restrictions; a browser check is still necessary for dependency-generated scripts.

## Revoke admin sessions without changing the password

`ADMIN_SESSION_EPOCH` is an optional non-secret revision, containing 1–64 letters, digits, `_` or
`-`. Its default is `0`. Set it to a **new unique value** through the deployment configuration and
restart every web instance to invalidate every previously issued admin session. The MAC and signed
payload bind the epoch. The admin password hash and session secret can stay unchanged. Never reuse
an earlier epoch, because its old unexpired cookies would become valid again.

`ADMIN_SESSION_NOT_BEFORE_MS` optionally rejects cookies issued before a Unix timestamp in
milliseconds. Its default is `0`. A future cutoff also prevents issuing a session before that time.
Malformed epoch/cutoff settings fail closed. Neither control has been set against a live deployment
by this implementation. Session format v2 also invalidates old format-v1 cookies when this source is
eventually deployed.

Browser logout clears its HttpOnly cookie. It does **not** individually revoke a stolen cookie on
other browsers. Use the epoch control for an incident. Password/session-secret rotation remains
available and also revokes sessions. Per-session durable revocation would require a central session
store and asynchronous authorization checks on every API and document request.

## Durable upload authorization and provider budgets

Migration 015 records consumed upload-signature digests and shared upload budgets. After checking
the wallet signature, a short SQL transaction admits at most three attempts per wallet and twenty
attempts globally per one-hour window. Failed preparations consume their admitted attempt. A signed
request cannot be reused by another web process or after a restart. Digests use decoded signature
bytes, so alternate base64 padding cannot bypass replay protection. Raw signatures and IP addresses
are not stored in these tables.

Authorization records expire after fifteen minutes, beyond the accepted message window, and are
bounded to 10,000 active rows. Expired authorizations and budget windows are removed during
admission. Reviewed launch modes require durable storage; a database failure stops preparation
before uploads. Only the database-free legacy devnet preview retains its old process-local fallback.
General API/IP limits and upload concurrency remain process-local; production edge abuse controls
are still needed.

Actual isolated TLS Postgres tests exercised concurrent connections, shared limits and duplicate
signature admission. An HTTP preparation uploaded metadata once and returned an unsigned launch;
after the web server restarted, the identical signed request was rejected before another upload. No
launch transaction was signed or sent in this test.

## Abandoned upload inventory

An image uploaded before a later preparation failure can remain pinned. New public Pinata uploads
carry private provider-side tags for app, mint, config, network genesis and artifact purpose, and
the application validates the returned file UUID/CID. Token metadata includes its mint so different
launches do not accidentally produce identical metadata documents solely from identical
names/images.

`node scripts/audit-upload-artifacts.mjs` inventories public Pinata files using the private operator
environment. It accepts no write/delete flag. It checks the actual RPC genesis, ignores untagged or
different-chain files, retains a 24-hour window, preserves existing mint/pool accounts and flags
duplicate CIDs. It prints review candidates only; it performs no deletion. An incomplete provider
listing is reported as incomplete. Old untagged files are not classified automatically.

Deleting an image CID without a complete reference check can break another token using that same
image. Review candidate references before removing files through the provider. Unpinning also does
not guarantee deletion from public IPFS or from other parties' caches. The provider's
[Files API](https://github.com/PinataCloud/pinata/blob/main/ai-instructions) exposes file receipts,
metadata tags and listing by file ID; no provider deletion endpoint is called by this tool.

## Durable token artwork metadata

Migration 014 creates a bounded, URI-keyed display cache. It stores only normalized `image` and
validated source-post URLs. Token identities, config, deployer, launch mode, fee rates, recipients
and financial balances still come from their verified chain/registry paths. Downloaded fields and
stored fields are revalidated with the same destination restrictions before use.

With `DATABASE_URL`, the application shares up to 5000 cache entries across processes. Fresh artwork
is reused for six hours; a request for stale artwork returns the existing image while refreshing in
the background. Empty images and failures retry after 30 seconds rather than becoming permanent
empty entries. A database outage preserves safe process-local stale data and retries later.
Development/legacy processes without a database retain the bounded in-process fallback.

One UUID lease permits a fetch per metadata URI. It expires after 30 seconds if the process crashes;
an active fetch renews it every 10 seconds. Completion checks the current, unexpired lease token, so
an abandoned response cannot overwrite a newer process's result. Capacity eviction keeps active
leases. All network operations happen after the short lease transaction commits. Local work is
limited to six concurrent jobs and 64 queued jobs; metadata downloads remain limited to 64 KiB and
URLs/values to 2048 bytes. Future/invalid cached schedules are repaired rather than suppressing
refresh forever. The on-chain metadata URI remains the lookup key; this cache never grants authority
to metadata content.

The migration is included in the normal reviewed migration sequence. SQL lifecycle, concurrency,
restart, stale/failure recovery, expiry and payload-validation tests use an isolated embedded
PostgreSQL instance. An actual isolated TLS Postgres test also proved two cache instances share one
HTTPS metadata download and a new Node process reuses the stored image without network access. These
tests do not change a deployed database.

## Saved launch recovery

The browser saves a public receipt before requesting broadcast. If the relay response is lost,
reconnect the same wallet on the original network and use **Check saved launch**. This checks the
original transaction and registration without requesting another launch signature. A timeout is
still pending; do not delete browser data to bypass that state.

The app offers an explicit clear-and-retry action only after a finalized failure or authenticated
expiry check, together with fresh evidence that no mint was initialized. A legacy receipt or a
receipt whose preparation MAC predates an admin-session-secret rotation can still be checked for
registration, but cannot authorize automatic expiry clearance. Keep the receipt for review in that
case. Changing only the admin session epoch revokes sessions without rotating this MAC secret.

Receipts are separated by wallet and network genesis. They contain public preparation context and
the transaction ID, with no mint private key or complete signed transaction. Browser data deletion
can still erase this local recovery copy; it does not cancel a submitted transaction.
