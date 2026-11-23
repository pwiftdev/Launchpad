# Custom domain — 1 November 2026

The live canonical site is **https://plzzz.bond**. Launching is available at
<https://plzzz.bond/launch>. Heroku web release **v67** is running with:

```text
NEXT_PUBLIC_SITE_URL=https://plzzz.bond
SITE_ALLOWED_ORIGINS=https://plzzz.bond,https://rinsed-launchpad-1675f6b9bebf.herokuapp.com,https://rinsed.fun
MAINNET_TRADING_ENABLED=true
LAUNCHPAD_PUBLIC=true
```

The apex domain was already attached to the web app, resolving to Heroku and serving a valid issued
ACM certificate when inspected. No DNS change was needed. The existing Heroku address remains an
allowed alias, including for pending wallet authorizations and launch receipt recovery.

`NEXT_PUBLIC_SITE_URL` is compiled into browser wallet metadata and share links, so changing only
runtime variables is insufficient. A fresh web build used an explicit public-origin override in
the reviewed source archive's build script. This left the previous running release's canonical
setting intact during compilation; the runtime canonical URL was switched after the build
succeeded. The workspace build script was not modified. Future normal builds use the configured
canonical variable directly. Private operator configuration, wallets and fees were not changed.

The new source archive SHA256 is
`50ffa2804ae721bd5ea587f8571fb194078fffa6f63742e339ec7cf918c06594`. Source archives exclude private
environment files and signing keys. The private staged web settings were also updated to the new
origin and aliases, preserving their existing staging gates.

Verification matched the running dyno to the successful v67 release and checked that release's
immutable configuration snapshot. Live HTTPS checks and a real browser confirmed:

- Mainnet launch status returns `canLaunch:true` with `bond-v1`.
- Both the custom domain and Heroku alias accept their own request origins. Invalid unsigned
  uploads are rejected before any upload or transaction takes place.
- The anonymous launch form and first-buy quote work on the custom domain.
- Token-page share URLs and share-image URLs use `https://plzzz.bond`.
- Desktop and 390px mobile checks pass with no page errors or failed API calls.
- Admin routes remain private; the automatic private operator is running.

No metadata was uploaded and no transaction was signed or broadcast during these checks. Report:
`.local/plzzz-domain-verified.public.json`.
